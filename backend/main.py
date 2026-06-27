"""
Interactive AI Vocal Coach — LiveKit Agent Backend
===================================================
Streams real-time vocal telemetry from the browser, maintains coaching context
via OpenAI Realtime Multimodal Audio, and issues barge-in corrections plus
session-control data-channel directives when critical vocal faults are detected.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    WorkerOptions,
    cli,
    llm,
)
from livekit.plugins.openai import realtime
from openai.types.beta.realtime.session import TurnDetection

load_dotenv()

logger = logging.getLogger("vocal-coach")
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Note-name helpers (A4 = 440 Hz, MIDI 69)
# ---------------------------------------------------------------------------

_NOTE_SEMITONES: dict[str, int] = {
    "C": 0, "B#": 0, "DB": 1, "C#": 1, "D": 2, "EB": 3, "D#": 3,
    "E": 4, "FB": 4, "F": 5, "E#": 5, "GB": 6, "F#": 6, "G": 7,
    "AB": 8, "G#": 8, "A": 9, "BB": 10, "A#": 10, "B": 11, "CB": 11,
}


def parse_note_name(name: str) -> tuple[int, int]:
    """Parse e.g. 'C#4' or 'Bb3' into (semitone_class, octave)."""
    normalized = name.strip().upper().replace("♯", "#").replace("♭", "B")
    match = re.match(r"^([A-G](?:#|B)?)(\d)$", normalized)
    if not match:
        raise ValueError(f"Invalid note name: {name!r} (expected format like C4 or F#3)")
    note_part, octave = match.group(1), int(match.group(2))
    semitone = _NOTE_SEMITONES.get(note_part)
    if semitone is None:
        raise ValueError(f"Unknown note: {note_part}")
    return semitone, octave


def note_to_hz(name: str) -> float:
    semitone, octave = parse_note_name(name)
    midi = (octave + 1) * 12 + semitone
    return 440.0 * (2.0 ** ((midi - 69) / 12))


def parse_note_list(note_names: str) -> list[str]:
    return [part.strip() for part in note_names.split(",") if part.strip()]

# ---------------------------------------------------------------------------
# Vocal Coach Agent
# ---------------------------------------------------------------------------

class VocalCoachAgent(Agent):
    """
    A LiveKit Agent that acts as an interactive AI vocal coach.

    * Ingests real-time VOCAL_METRICS telemetry from the client via data
      channels and injects it into the RealtimeSession conversation context.
    * On CRITICAL_ERROR events, forcefully interrupts playback, pauses the
      client-side lyric player, and delivers an immediate spoken correction.
    * Exposes an LLM-callable tool `control_session_playback` so the model
      can autonomously issue PAUSE_TRACK / RESUME_TRACK / SHOW_TIPS
      directives to the frontend.
    """

    SYSTEM_INSTRUCTIONS = (
        "You are an expert AI vocal coach conducting a live singing lesson. "
        "You listen to the student's voice in real time and receive continuous "
        "vocal telemetry (volume in dB, pitch in Hz, and syllable-level accuracy "
        "when they are singing a notated song). "
        "Your job is to:\n"
        "1. Provide encouraging, specific feedback on pitch accuracy, breath "
        "control, and volume consistency — reference the current syllable when "
        "telemetry includes one.\n"
        "2. If you detect a critical vocal fault (volume dropping to silence "
        "or pitch going off the expected note for the active syllable), "
        "IMMEDIATELY interrupt, explain what went wrong, and guide the student "
        "to correct it.\n"
        "3. Use the `control_session_playback` tool to pause or resume the "
        "backing track and show coaching tips in the UI.\n"
        "4. Use `play_reference_tone` to play the correct pitch for a syllable "
        "on the student's speakers so they can hear the target note.\n"
        "5. Use `demonstrate_syllable` to play a reference tone AND sing/hum "
        "that syllable yourself so the student can mimic you.\n"
        "6. Use `sing_lyric_line` to play and sing an entire lyric line with "
        "correct pitches — great for teaching a phrase by example.\n"
        "7. Use `demonstrate_notes` whenever the student asks about music "
        "theory, note names (A, B, C, etc.), pitch, scales, or vocal technique "
        "like singing higher — ALWAYS play the note(s) on their speakers first, "
        "then explain clearly while they listen or right after. For high-pitch "
        "questions, play an ascending sequence (e.g. C4,D4,E4,F4,G4,A4,B4,C5).\n"
        "8. Use `request_detailed_analysis` when you need precise pitch "
        "confidence, clarity, and note-name data from the student's mic.\n"
        "9. Keep your spoken responses concise and warm — you are coaching, "
        "not lecturing.\n"
        "10. When the student is doing well, simply let them continue and "
        "offer brief positive reinforcement."
    )

    def __init__(self, ctx: "JobContext", session_ref: dict[str, Any]) -> None:
        super().__init__(instructions=self.SYSTEM_INSTRUCTIONS)
        self._ctx = ctx
        self._session_ref = session_ref

    async def _publish_session_action(self, payload: dict) -> None:
        await self._ctx.room.local_participant.publish_data(
            payload=json.dumps(payload).encode("utf-8"),
            topic="session_control",
            reliable=True,
        )

    @llm.function_tool(
        description=(
            "Control the student's session playback and display coaching tips "
            "in their UI. Use action PAUSE_TRACK to stop the backing track, "
            "RESUME_TRACK to restart it, or SHOW_TIPS to display guidance "
            "without affecting playback."
        )
    )
    async def control_session_playback(
        self,
        action: str,
        coach_notes: str,
    ) -> str:
        """
        Args:
            action: The playback control action. Must be one of: PAUSE_TRACK, RESUME_TRACK, SHOW_TIPS.
            coach_notes: A short coaching note or tip to display to the student in the UI alongside the action.
        """
        room = self._ctx.room
        directive = json.dumps({"action": action, "coach_notes": coach_notes})
        await room.local_participant.publish_data(
            payload=directive.encode("utf-8"),
            topic="session_control",
            reliable=True,
        )
        logger.info("Dispatched directive → %s", directive)
        return f"Directive sent: {action}"

    @llm.function_tool(
        description=(
            "Display a short 1–3 word visual coaching cue on the student's "
            "screen WITHOUT speaking. Use in conversational non-interrupt "
            "mode while they are singing. Examples: 'Louder', 'Sharp ↑', "
            "'Flat ↓', 'Great!', 'Keep going', 'Steady', 'Breathe'."
        )
    )
    async def show_visual_cue(
        self,
        cue: str,
        tone: str = "neutral",
    ) -> str:
        """
        Args:
            cue: A 1–3 word glanceable instruction (max ~20 characters).
            tone: Visual style — one of: positive, corrective, neutral.
        """
        await self._publish_session_action({
            "action": "SHOW_CUE",
            "cue": cue.strip()[:24],
            "tone": tone if tone in ("positive", "corrective", "neutral") else "neutral",
        })
        logger.info("Visual cue → %s (%s)", cue, tone)
        return cue

    @llm.function_tool(
        description=(
            "Play a reference sine tone at the target pitch on the student's "
            "speakers. Use when the student needs to hear the correct note "
            "for a syllable before trying again."
        )
    )
    async def play_reference_tone(
        self,
        frequency_hz: float,
        syllable: str,
        duration_seconds: float = 1.2,
    ) -> str:
        """
        Args:
            frequency_hz: Target pitch in Hz for the reference tone.
            syllable: The syllable token being demonstrated (e.g. 'b_ii').
            duration_seconds: How long to play the tone (default 1.2s).
        """
        await self._publish_session_action({
            "action": "PLAY_REFERENCE_TONE",
            "frequency_hz": frequency_hz,
            "syllable": syllable,
            "duration_ms": int(duration_seconds * 1000),
            "coach_notes": f"Listen to the target pitch for '{syllable}' ({frequency_hz:.0f} Hz)",
        })
        return f"Playing reference tone {frequency_hz:.0f} Hz for '{syllable}'"

    @llm.function_tool(
        description=(
            "Play one or more named musical notes on the student's speakers while "
            "you explain. REQUIRED when they ask music-instruction questions: "
            "what a note sounds like (A, B, C, etc.), how pitch works, scales, "
            "or how to sing higher/lower. Pass comma-separated note names — "
            "single note ('B4'), comparison ('C4,E4,G4'), or ascending scale "
            "('C4,D4,E4,F4,G4,A4,B4,C5') for high-pitch demos. Speak and explain "
            "while or after playing."
        )
    )
    async def demonstrate_notes(
        self,
        note_names: str,
        pause_track: bool = True,
        seconds_per_note: float = 1.2,
        coach_notes: str = "",
    ) -> str:
        """
        Args:
            note_names: Comma-separated note names to play in order (e.g. 'B4' or 'C4,D4,E4,F4,G4').
            pause_track: Pause karaoke backing track before playing (default True).
            seconds_per_note: How long each note plays (default 1.2s).
            coach_notes: Short label shown in the UI while notes play.
        """
        names = parse_note_list(note_names)
        if not names:
            return "No valid note names provided."

        notes_payload: list[dict[str, Any]] = []
        for name in names:
            try:
                hz = note_to_hz(name)
            except ValueError as exc:
                return str(exc)
            notes_payload.append({
                "note_name": name.upper(),
                "frequency_hz": round(hz, 2),
                "duration_ms": int(seconds_per_note * 1000),
            })

        if pause_track:
            await self._publish_session_action({
                "action": "PAUSE_TRACK",
                "coach_notes": coach_notes or f"Listen: {', '.join(n['note_name'] for n in notes_payload)}",
            })
            await asyncio.sleep(0.15)

        label = coach_notes or f"Playing: {', '.join(n['note_name'] for n in notes_payload)}"
        await self._publish_session_action({
            "action": "PLAY_NOTE_SEQUENCE",
            "notes": notes_payload,
            "coach_notes": label,
        })

        played = ", ".join(n["note_name"] for n in notes_payload)
        logger.info("Demonstrated notes → %s", played)
        return f"Playing notes on student speakers: {played}. Now explain what they are hearing."

    @llm.function_tool(
        description=(
            "Demonstrate a syllable: pause the track, play the reference tone "
            "on the student's speakers, then YOU sing/hum that syllable at the "
            "correct pitch so the student can mimic you. Best for corrections."
        )
    )
    async def demonstrate_syllable(
        self,
        syllable: str,
        frequency_hz: float,
        lyric_hint: str = "",
    ) -> str:
        """
        Args:
            syllable: Syllable token to demonstrate (e.g. 'b_ii').
            frequency_hz: Target pitch in Hz.
            lyric_hint: Optional human lyric context (e.g. 'B' in the alphabet).
        """
        await self._publish_session_action({
            "action": "PAUSE_TRACK",
            "coach_notes": f"Demonstrating '{syllable}' — listen, then sing along.",
        })
        await asyncio.sleep(0.2)
        await self._publish_session_action({
            "action": "PLAY_REFERENCE_TONE",
            "frequency_hz": frequency_hz,
            "syllable": syllable,
            "duration_ms": 1400,
        })
        await asyncio.sleep(1.6)

        session = self._session_ref.get("session")
        hint = f" ({lyric_hint})" if lyric_hint else ""
        if session:
            await session.generate_reply(
                instructions=(
                    f"Sing or hum only the syllable '{syllable}'{hint} at "
                    f"{frequency_hz:.0f} Hz clearly and warmly — one sustained "
                    f"note, about 1 second. Then invite the student to match you."
                )
            )
        return f"Demonstrated '{syllable}' at {frequency_hz:.0f} Hz"

    @llm.function_tool(
        description=(
            "Sing an entire lyric line with correct pitches: plays a sequence "
            "of reference tones on the student's speakers, then you sing the "
            "full line. line_index is 0-based (0 = first line 'A B C D E F G')."
        )
    )
    async def sing_lyric_line(
        self,
        line_index: int,
        lyric_text: str,
    ) -> str:
        """
        Args:
            line_index: 0-based index of the lyric line in the song.
            lyric_text: The human-readable lyric for that line.
        """
        await self._publish_session_action({
            "action": "PAUSE_TRACK",
            "coach_notes": f"Coach will sing: \"{lyric_text}\"",
        })
        await asyncio.sleep(0.2)
        await self._publish_session_action({
            "action": "PLAY_LYRIC_LINE",
            "line_index": line_index,
            "lyric_text": lyric_text,
            "coach_notes": f"Playing pitches for: {lyric_text}",
        })

        session = self._session_ref.get("session")
        if session:
            await asyncio.sleep(5.0)
            await session.generate_reply(
                instructions=(
                    f"Sing the lyric line \"{lyric_text}\" clearly with correct "
                    f"pitches, syllable by syllable. Keep it musical and warm, "
                    f"then ask the student to sing it back with you."
                )
            )
        return f"Sang lyric line {line_index}: {lyric_text}"

    @llm.function_tool(
        description=(
            "Request a detailed audio analysis snapshot from the student's "
            "microphone: pitch confidence, harmonic clarity, note name, and "
            "syllable accuracy. Use before giving precise technical feedback."
        )
    )
    async def request_detailed_analysis(self, reason: str) -> str:
        """
        Args:
            reason: Why you need the analysis (e.g. 'checking pitch on b_ii').
        """
        await self._publish_session_action({
            "action": "REQUEST_ANALYSIS",
            "coach_notes": f"Analyzing your voice: {reason}",
        })
        return "Analysis snapshot requested from client"


# ---------------------------------------------------------------------------
# Entry-point & Session Lifecycle
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext) -> None:
    """Called once per room join — wires up telemetry listeners & starts the agent."""

    logger.info("Job accepted for room %s", ctx.room.name)

    openai_realtime = realtime.RealtimeModel(
        voice="shimmer",
        modalities=["audio", "text"],
        turn_detection=TurnDetection(
            type="server_vad",
            threshold=0.45,        # slightly more sensitive than 0.5
            prefix_padding_ms=200,
            silence_duration_ms=400,  # respond faster after user stops talking
        ),
    )

    session_ref: dict[str, Any] = {"session": None}
    agent = VocalCoachAgent(ctx=ctx, session_ref=session_ref)
    session = AgentSession(
        llm=openai_realtime,
    )

    # Throttle telemetry injections to avoid flooding the chat context.
    last_telemetry_at = 0.0
    telemetry_lock = asyncio.Lock()
    coaching_mode = "karaoke"
    non_interrupt_mode = False
    current_song: dict | None = None

    async def inject_coaching_mode_context(mode: str, non_interrupt: bool) -> None:
        if mode == "conversational" and non_interrupt:
            content = (
                "[CONVERSATIONAL NON-INTERRUPT MODE ACTIVE]\n"
                "The student is singing or speaking freely with NO backing track.\n"
                "CRITICAL RULES:\n"
                "1. NEVER speak out loud while the student is actively singing or voicing.\n"
                "2. Use ONLY `show_visual_cue` for real-time feedback — never long sentences.\n"
                "3. Cues must be 1–3 words max (e.g. 'Louder', 'Sharp ↑', 'Flat ↓', "
                "'Great!', 'Keep going', 'Steady', 'Breathe', 'Nice tone').\n"
                "4. Use tone 'positive' for praise, 'corrective' for fixes, 'neutral' otherwise.\n"
                "5. React to LIVE TELEMETRY: low volume → 'Louder'; good pitch → 'Great!' "
                "or 'Keep going'; off pitch → 'Sharp ↑' or 'Flat ↓'.\n"
                "6. When the student asks a music-theory or instructional question "
                "(e.g. 'what is a B note', 'how do high pitches work', 'explain C "
                "sharp'), use `demonstrate_notes` to play examples on their speakers "
                "and explain in full sentences.\n"
                "7. When the student requests feedback (REQUEST_FEEDBACK), you MAY speak "
                "in full sentences with a detailed critique.\n"
                "8. Do NOT pause playback, play reference tones, or demonstrate unless asked."
            )
        elif mode == "conversational":
            content = (
                "[CONVERSATIONAL MODE ACTIVE]\n"
                "Free-talk mode with no backing track. You may speak normally for coaching."
            )
        else:
            content = (
                "[KARAOKE MODE ACTIVE]\n"
                "Backing track and syllable-level pitch tracking are enabled."
            )

        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=content)
        await agent.update_chat_ctx(chat_ctx)
        logger.info("Coaching context injected: mode=%s non_interrupt=%s", mode, non_interrupt)

    async def inject_song_context(song: dict) -> None:
        nonlocal current_song
        current_song = song
        songname = song.get("songname", "Unknown")
        tempo = song.get("tempo", "")
        excerpt = song.get("lyric_excerpt", "")
        song_context = (
            f"[SONG SELECTED] The student is practicing \"{songname}\" "
            f"at {tempo} BPM. Opening lyric: \"{excerpt}\". "
            "You will receive syllable-level pitch results as they sing."
        )
        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=song_context)
        await agent.update_chat_ctx(chat_ctx)
        logger.info("Song context set: %s", songname)

    async def inject_syllable_result(result: dict) -> None:
        syllable = result.get("syllable", "?")
        issue = result.get("issue", "unknown")
        cents = result.get("pitch_error_cents", 0)
        if issue == "ok":
            note = f"[SYLLABLE OK] Student sang '{syllable}' on pitch."
        elif issue == "sharp":
            note = f"[SYLLABLE SHARP] Student sang '{syllable}' {abs(cents):.0f} cents sharp."
        elif issue == "flat":
            note = f"[SYLLABLE FLAT] Student sang '{syllable}' {abs(cents):.0f} cents flat."
        elif issue == "quiet":
            note = f"[SYLLABLE QUIET] Student sang '{syllable}' too quietly."
        elif issue == "missed":
            note = f"[SYLLABLE MISSED] No clear pitch detected on '{syllable}'."
        else:
            note = f"[SYLLABLE] '{syllable}' issue: {issue}."

        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=note)
        await agent.update_chat_ctx(chat_ctx)

    async def inject_telemetry(metrics: dict) -> None:
        nonlocal last_telemetry_at

        now = time.monotonic()
        if now - last_telemetry_at < 2.0:
            return

        async with telemetry_lock:
            if now - last_telemetry_at < 2.0:
                return

            volume_db = metrics.get("volume_db", 0)
            pitch_hz = metrics.get("pitch_hz", 0)
            mode = metrics.get("coaching_mode", coaching_mode)
            syllable = metrics.get("syllable")
            expected_hz = metrics.get("expected_pitch_hz")
            delta_cents = metrics.get("pitch_delta_cents")
            on_pitch = metrics.get("on_pitch")

            parts = [
                f"[LIVE TELEMETRY — {mode} mode]",
                f"Volume: {volume_db:.1f} dB, Pitch: {pitch_hz:.1f} Hz",
            ]
            if syllable:
                parts.append(f"Syllable: {syllable}")
            if expected_hz:
                parts.append(f"Expected: {expected_hz:.1f} Hz")
            if delta_cents is not None and pitch_hz > 0:
                parts.append(f"Delta: {delta_cents:.0f} cents")
            if on_pitch is not None:
                parts.append(f"On pitch: {on_pitch}")
            confidence = metrics.get("pitch_confidence")
            clarity = metrics.get("clarity")
            note = metrics.get("note_name")
            is_voiced = metrics.get("is_voiced")
            if confidence is not None:
                parts.append(f"Confidence: {confidence:.0%}")
            if clarity is not None:
                parts.append(f"Clarity: {clarity:.0%}")
            if note:
                parts.append(f"Detected note: {note}")
            if is_voiced is not None:
                parts.append(f"Voiced: {is_voiced}")

            telemetry_context = ". ".join(parts) + "."

            chat_ctx = agent.chat_ctx.copy()
            chat_ctx.add_message(role="system", content=telemetry_context)
            await agent.update_chat_ctx(chat_ctx)

            last_telemetry_at = now
            logger.debug("Injected telemetry: %s", telemetry_context)

    async def inject_analysis_snapshot(snapshot: dict) -> None:
        parts = ["[DETAILED ANALYSIS SNAPSHOT]"]
        if snapshot.get("syllable"):
            parts.append(f"Syllable: {snapshot['syllable']}")
        if snapshot.get("note_name"):
            parts.append(f"Note: {snapshot['note_name']}")
        parts.append(f"Pitch: {snapshot.get('pitch_hz', 0):.1f} Hz")
        if snapshot.get("expected_pitch_hz"):
            parts.append(f"Expected: {snapshot['expected_pitch_hz']:.1f} Hz")
        if snapshot.get("pitch_delta_cents") is not None:
            parts.append(f"Delta: {snapshot['pitch_delta_cents']:.0f} cents")
        parts.append(f"Confidence: {snapshot.get('pitch_confidence', 0):.0%}")
        parts.append(f"Clarity: {snapshot.get('clarity', 0):.0%}")
        parts.append(f"Voiced: {snapshot.get('is_voiced', False)}")
        parts.append(f"Volume: {snapshot.get('volume_db', 0):.1f} dB")

        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=". ".join(parts) + ".")
        await agent.update_chat_ctx(chat_ctx)
        logger.info("Injected analysis snapshot")

    @ctx.room.on("data_received")
    def _on_data_received(packet: rtc.DataPacket) -> None:
        nonlocal coaching_mode, non_interrupt_mode
        try:
            raw = packet.data.decode("utf-8")
            message = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            logger.warning("Malformed data packet: %s", exc)
            return

        msg_type = message.get("type")

        if msg_type == "VOCAL_METRICS":
            asyncio.create_task(inject_telemetry(message))
        elif msg_type == "SONG_SELECTED":
            asyncio.create_task(inject_song_context(message))
        elif msg_type == "SYLLABLE_RESULT":
            asyncio.create_task(inject_syllable_result(message))
        elif msg_type == "COACHING_MODE":
            coaching_mode = message.get("mode", coaching_mode)
            asyncio.create_task(
                inject_coaching_mode_context(coaching_mode, non_interrupt_mode)
            )
            logger.info("Coaching mode set to %s", coaching_mode)
        elif msg_type == "NON_INTERRUPT_MODE":
            non_interrupt_mode = bool(message.get("enabled", non_interrupt_mode))
            asyncio.create_task(
                inject_coaching_mode_context(coaching_mode, non_interrupt_mode)
            )
            logger.info("Non-interrupt mode set to %s", non_interrupt_mode)
        elif msg_type == "CRITICAL_ERROR":
            asyncio.create_task(
                _handle_critical_error(
                    session,
                    ctx,
                    message,
                    coaching_mode=coaching_mode,
                    non_interrupt=non_interrupt_mode,
                )
            )
        elif msg_type == "REQUEST_FEEDBACK":
            asyncio.create_task(_handle_request_feedback(session, ctx))
        elif msg_type == "ANALYSIS_SNAPSHOT":
            asyncio.create_task(inject_analysis_snapshot(message))
        else:
            logger.debug("Unknown data-channel message type: %s", msg_type)

    # AgentSession connects to the room on start (per LiveKit docs).
    await session.start(
        room=ctx.room,
        agent=agent,
    )
    session_ref["session"] = session
    logger.info("Connected to room %s", ctx.room.name)

    participant = await ctx.wait_for_participant()
    logger.info("Participant joined: %s", participant.identity)

    await session.generate_reply(
        instructions=(
            "Greet the student warmly. Introduce yourself as their AI vocal "
            "coach. Let them know they'll be singing the Alphabet song with "
            "lyrics on screen, and you'll monitor their pitch syllable by "
            "syllable. You can play reference tones, sing demonstrations, and "
            "request detailed analysis when they need help. They can also ask "
            "you about notes, pitch, and singing technique — you'll play examples "
            "and explain. Ask them to press Start Session and sing along when ready."
        )
    )
    logger.info("Agent session started for participant %s", participant.identity)


# ---------------------------------------------------------------------------
# Feedback Handler
# ---------------------------------------------------------------------------

async def _handle_request_feedback(session: AgentSession, ctx: JobContext) -> None:
    """Triggered when the student finishes singing and requests feedback."""
    logger.info("Student requested performance feedback.")
    
    # Interrupt any active speech
    session.interrupt()
    
    # Force pause client playback
    pause_directive = json.dumps({
        "action": "PAUSE_TRACK",
        "coach_notes": "Analyzing session and preparing verbal critique...",
    })
    await ctx.room.local_participant.publish_data(
        payload=pause_directive.encode("utf-8"),
        topic="session_control",
        reliable=True,
    )
    
    await session.generate_reply(
        instructions=(
            "The student has completed their singing performance and requested feedback. "
            "Review the syllable-level results and live telemetry from the conversation history. "
            "Name specific syllables that were sharp, flat, quiet, or missed, and what went well. "
            "Give a constructive, encouraging verbal critique with one clear target improvement."
        )
    )


# ---------------------------------------------------------------------------
# Critical Error Handler
# ---------------------------------------------------------------------------

async def _handle_critical_error(
    session: AgentSession,
    ctx: JobContext,
    error: dict,
    coaching_mode: str = "karaoke",
    non_interrupt: bool = False,
) -> None:
    """
    Execute the barge-in interruption pipeline:
    1. Clear any queued / in-progress agent speech.
    2. Dispatch a PAUSE_TRACK directive to freeze the client UI.
    3. Force the model to deliver an immediate spoken correction.

    In conversational non-interrupt mode, skip speech and send a visual cue only.
    """
    reason = error.get("reason", "UNKNOWN_FAULT")
    syllable = error.get("syllable")
    expected_hz = error.get("expected_hz")
    actual_hz = error.get("actual_hz")
    logger.warning(
        "CRITICAL VOCAL ERROR received: %s (syllable=%s)", reason, syllable
    )

    if coaching_mode == "conversational" and non_interrupt:
        cue = "Focus"
        tone = "corrective"
        if reason == "VOLUME_SILENCE":
            cue, tone = "Louder", "corrective"
        elif reason == "PITCH_DISTORTION_OUT_OF_BOUNDS":
            cue, tone = "Steady", "corrective"
        elif reason == "PITCH_OFF_TARGET" and expected_hz and actual_hz:
            cue = "Sharp ↑" if actual_hz > expected_hz else "Flat ↓"
            tone = "corrective"
        elif reason == "PITCH_OFF_TARGET":
            cue, tone = "Adjust pitch", "corrective"

        cue_directive = json.dumps({
            "action": "SHOW_CUE",
            "cue": cue,
            "tone": tone,
        })
        await ctx.room.local_participant.publish_data(
            payload=cue_directive.encode("utf-8"),
            topic="session_control",
            reliable=True,
        )
        logger.info("Visual cue dispatched for %s: %s", reason, cue)
        return

    # 1 ▸ Interrupt current agent output
    session.interrupt()

    # 2 ▸ Pause the client-side track immediately
    coach_note = f"Critical issue: {reason}"
    if syllable:
        coach_note += f" on syllable '{syllable}'"
    pause_directive = json.dumps({
        "action": "PAUSE_TRACK",
        "coach_notes": coach_note + ". Pausing for correction.",
    })
    await ctx.room.local_participant.publish_data(
        payload=pause_directive.encode("utf-8"),
        topic="session_control",
        reliable=True,
    )

    # 3 ▸ Inject a high-priority instruction and force a reply
    correction_map = {
        "VOLUME_SILENCE": (
            "The student's voice has dropped to complete silence. "
            "Immediately interrupt, ask if they are okay, remind them to "
            "project from the diaphragm, and tell them to try the phrase "
            "again when ready."
        ),
        "PITCH_DISTORTION_OUT_OF_BOUNDS": (
            "The student's pitch has deviated far outside the target scale. "
            "Immediately interrupt, tell them their pitch went sharp/flat, "
            "guide them to drop or raise by roughly half a step, and ask "
            "them to retry the phrase slowly."
        ),
        "PITCH_OFF_TARGET": (
            f"The student's pitch is off target on syllable '{syllable or 'unknown'}'. "
            f"Expected around {expected_hz:.0f} Hz but heard {actual_hz:.0f} Hz. "
            "Immediately interrupt, tell them whether they are sharp or flat, "
            "name the syllable if known, and guide them to match the reference pitch."
            if syllable and expected_hz and actual_hz
            else "The student's pitch is off target for the current syllable. "
            "Immediately interrupt, tell them whether they are sharp or flat, "
            "and guide them to match the reference pitch on the active syllable."
        ),
    }

    correction_instruction = correction_map.get(
        reason,
        (
            f"A critical vocal fault was detected: {reason}. "
            "Immediately interrupt the student with a brief, supportive "
            "correction and ask them to try again."
        ),
    )

    await session.generate_reply(instructions=correction_instruction)
    logger.info("Barge-in correction dispatched for reason: %s", reason)


# ---------------------------------------------------------------------------
# CLI Bootstrap
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="vocal-coach"))
