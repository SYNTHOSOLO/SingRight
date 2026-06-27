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
import math
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
from openai.types.beta.realtime.session import InputAudioTranscription, TurnDetection

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


def parse_note_name(name: str, default_octave: int = 4) -> tuple[int, int]:
    """Parse e.g. 'C#4', 'Bb3', or bare 'A' (defaults to octave 4)."""
    normalized = re.sub(r"\s+", "", name.strip().upper().replace("♯", "#").replace("♭", "B"))
    match = re.match(r"^([A-G](?:#|B)?)(\d)?$", normalized)
    if not match:
        raise ValueError(f"Invalid note name: {name!r} (expected C4, G3, A, etc.)")
    note_part = match.group(1)
    octave = int(match.group(2)) if match.group(2) else default_octave
    semitone = _NOTE_SEMITONES.get(note_part)
    if semitone is None:
        raise ValueError(f"Unknown note: {note_part}")
    return semitone, octave


def normalize_note_name(name: str, default_octave: int = 4) -> str:
    semitone, octave = parse_note_name(name, default_octave)
    label = [k for k, v in _NOTE_SEMITONES.items() if v == semitone and len(k) <= 2]
    # Prefer sharp spelling for display
    note_part = next((k for k in ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B") if _NOTE_SEMITONES.get(k) == semitone), label[0])
    return f"{note_part}{octave}"


def parse_note_list(note_names: str, default_octave: int = 4) -> list[str]:
    stripped = note_names.strip()
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [normalize_note_name(str(item), default_octave) for item in parsed]
        except json.JSONDecodeError:
            pass
    return [
        normalize_note_name(part, default_octave)
        for part in note_names.split(",")
        if part.strip()
    ]


def parse_pitch_input(value: str, default_octave: int = 4) -> tuple[str, float]:
    """Parse note name (G3, A) or raw Hz (440, 262 Hz) into (note_name, hz)."""
    raw = value.strip()
    hz_match = re.match(r"^([\d.]+)\s*(?:hz)?$", raw, re.IGNORECASE)
    if hz_match:
        hz = float(hz_match.group(1))
        if hz <= 0:
            raise ValueError(f"Invalid frequency: {value!r}")
        return hz_to_note_name(hz), hz
    name = normalize_note_name(raw, default_octave)
    return name, note_to_hz(name)


def build_notes_payload(
    names: list[str], seconds_per_note: float = 1.2
) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for name in names:
        hz = note_to_hz(name)
        payload.append({
            "note_name": name,
            "frequency_hz": round(hz, 2),
            "duration_ms": int(seconds_per_note * 1000),
        })
    return payload


def note_to_hz(name: str) -> float:
    semitone, octave = parse_note_name(name)
    midi = (octave + 1) * 12 + semitone
    return 440.0 * (2.0 ** ((midi - 69) / 12))


def hz_to_note_name(hz: float) -> str:
    if hz <= 0:
        return ""
    midi = round(69 + 12 * math.log2(hz / 440))
    octave = midi // 12 - 1
    name = _NOTE_NAMES[midi % 12]
    return f"{name}{octave}"


_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_CHORD_INTERVALS: dict[str, list[int]] = {
    "MAJ": [0, 4, 7],
    "MIN": [0, 3, 7],
    "DIM": [0, 3, 6],
    "AUG": [0, 4, 8],
    "7": [0, 4, 7, 10],
    "MAJ7": [0, 4, 7, 11],
    "MIN7": [0, 3, 7, 10],
}

SESSION_STATE_MARKER = "[SESSION STATE]"

AUDIO_CAPABILITY_BLOCK = (
    "BUILT-IN AUDIO (always available): You play real piano/guitar samples in the "
    "student's browser and highlight keys on the Note Board. Tools: teach_pitch "
    "(notes/scales), play_note (single note), play_chord (C, Dm, G7, etc.), "
    "demonstrate_notes (sequences), show_notes_on_piano (visual only), "
    "play_reference_tone, demonstrate_syllable, sing_lyric_line. "
    "When teaching or explaining pitch, CALL A TOOL FIRST — then talk. "
    "NEVER say you cannot play audio, are text-only, or lack an instrument."
)

ENGLISH_ONLY_RULE = (
    "CRITICAL — ENGLISH ONLY (non-negotiable):\n"
    "• You MUST speak ONLY English in every spoken response — no exceptions.\n"
    "• NEVER use Spanish, French, or any other language — not even a single word.\n"
    "• If the student speaks another language, still respond ONLY in English.\n"
    "• All greetings, corrections, tips, demonstrations, and feedback: English only.\n"
    "• This rule overrides everything else. English only. Always English."
)


def _english_reply(instructions: str) -> str:
    """Wrap ad-hoc reply instructions with repeated English-only enforcement."""
    return f"{ENGLISH_ONLY_RULE}\n\n{instructions.strip()}\n\n{ENGLISH_ONLY_RULE}"

MAX_CHAT_ITEMS = 48


def _message_text(item: Any) -> str:
    content = getattr(item, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                parts.append(str(part.get("text", "")))
            else:
                parts.append(str(part))
        return " ".join(parts)
    return str(content)


def _strip_system_messages_with_markers(
    chat_ctx: llm.ChatContext, markers: tuple[str, ...]
) -> None:
    chat_ctx.items = [
        item
        for item in chat_ctx.items
        if not (
            getattr(item, "type", None) == "message"
            and getattr(item, "role", None) == "system"
            and any(_message_text(item).startswith(marker) for marker in markers)
        )
    ]


async def _commit_chat_ctx(agent: Agent, chat_ctx: llm.ChatContext) -> None:
    chat_ctx.truncate(max_items=MAX_CHAT_ITEMS)
    await agent.update_chat_ctx(chat_ctx)


def parse_chord_name(chord: str, default_octave: int = 4) -> list[str]:
    """Parse chord names like C, Dm, F#maj7, Bb into note names."""
    normalized = (
        chord.strip()
        .upper()
        .replace("MAJOR", "MAJ")
        .replace("MINOR", "MIN")
        .replace("♯", "#")
        .replace("♭", "B")
    )
    normalized = re.sub(r"\s+", "", normalized)
    normalized = re.sub(r"CHORD$", "", normalized)

    quality = "MAJ"
    root_name = normalized
    quality_match = re.match(
        r"^([A-G](?:#|B)?)(MAJ7|MIN7|MAJ|MIN|DIM|AUG|7)$",
        normalized,
    )
    if quality_match:
        root_name = quality_match.group(1)
        quality = quality_match.group(2)
    elif re.match(r"^([A-G](?:#|B)?)M$", normalized):
        root_name = normalized[:-1]
        quality = "MIN"

    intervals = _CHORD_INTERVALS.get(quality)
    if intervals is None:
        raise ValueError(f"Invalid chord name: {chord!r}")

    root_semitone, _ = parse_note_name(root_name, default_octave)
    root_midi = (default_octave + 1) * 12 + root_semitone
    return [
        f"{_NOTE_NAMES[(root_midi + interval) % 12]}{(root_midi + interval) // 12 - 1}"
        for interval in intervals
    ]


def try_parse_chord_or_notes(value: str, default_octave: int = 4) -> list[str] | None:
    """Return note names if value looks like a chord; None otherwise."""
    raw = value.strip()
    if not raw:
        return None
    if re.search(r"chord", raw, re.IGNORECASE) or re.match(
        r"^[A-G](?:#|b|♯|♭)?(?:maj7|min7|maj|min|dim|aug|m7|7|m)?$",
        raw.strip(),
        re.IGNORECASE,
    ):
        chord_token = re.sub(r".*?\b([A-G](?:#|b|♯|♭)?(?:maj7|min7|maj|min|dim|aug|m7|7|m)?)\b.*", r"\1", raw, flags=re.IGNORECASE)
        try:
            return parse_chord_name(chord_token, default_octave)
        except ValueError:
            return None
    return None


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
        "You are an expert AI vocal coach conducting a live singing lesson.\n\n"
        f"{ENGLISH_ONLY_RULE}\n\n"
        f"{AUDIO_CAPABILITY_BLOCK}\n\n"
        "Examples you MUST use tools for:\n"
        "- 'What does G3 sound like?' → call teach_pitch('G3')\n"
        "- 'Play a C chord' → call play_chord('C')\n"
        "- 'Show me the notes in Dm' → call show_notes_on_piano('D,F,A') or play_chord('Dm')\n"
        "- 'Play C,E,G' scale → call teach_pitch('C4,E4,G4')\n\n"
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
        "3. Use the `control_session_playback` tool to pause, resume, or restart "
        "the backing track and show coaching tips in the UI. Use RESTART_TRACK "
        "(not RESUME_TRACK) when the student says 'play again', 'start over', "
        "or wants the song from the beginning.\n"
        "4. Use `play_reference_tone` to play the correct pitch for a syllable "
        "on the student's speakers so they can hear the target note.\n"
        "5. Use `demonstrate_syllable` to play a reference tone AND sing/hum "
        "that syllable yourself so the student can mimic you.\n"
        "6. Use `sing_lyric_line` to play and sing an entire lyric line with "
        "correct pitches — great for teaching a phrase by example.\n"
        "7. TEACHING PITCHES & CHORDS — when the student asks to play, hear, or "
        "see a note, chord, pitch, or sound, you MUST call teach_pitch, play_note, "
        "or play_chord IMMEDIATELY. NEVER guess Hz or note names in speech without "
        "playing/showing first. The client may send USER_PLAY_REQUEST — confirm "
        "playback; do not contradict it.\n"
        "8. When INSTRUMENT FOLLOW is ON, the student's pitch is mirrored live "
        "as piano/guitar in their browser — use the same instrument setting for demos.\n"
        "9. Use `request_detailed_analysis` when you need precise pitch "
        "confidence, clarity, and note-name data from the student's mic.\n"
        "10. Keep your spoken responses concise and warm — you are coaching, "
        "not lecturing.\n"
        "11. When the student is doing well, simply let them continue and "
        "offer brief positive reinforcement.\n\n"
        f"{ENGLISH_ONLY_RULE}"
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

    async def _publish_notes_display(
        self,
        notes_payload: list[dict[str, Any]],
        instrument: str,
        coach_notes: str,
    ) -> None:
        await self._publish_session_action({
            "action": "SHOW_NOTES",
            "notes": notes_payload,
            "instrument": instrument,
            "coach_notes": coach_notes,
        })

    async def _teach_with_notes(
        self,
        notes_payload: list[dict[str, Any]],
        *,
        instrument: str = "piano",
        coach_notes: str = "",
        pause_track: bool = True,
        show_on_board: bool = True,
        play_sound: bool = True,
        invite_to_sing: bool = True,
    ) -> str:
        if not notes_payload:
            return "No notes to teach."

        inst = instrument if instrument in ("piano", "guitar", "both") else "piano"
        played = ", ".join(n["note_name"] for n in notes_payload)
        label = coach_notes or f"{'Showing' if not play_sound else 'Playing'}: {played}"

        if pause_track and play_sound:
            await self._publish_session_action({
                "action": "PAUSE_TRACK",
                "coach_notes": label,
            })
            await asyncio.sleep(0.15)

        if show_on_board:
            await self._publish_notes_display(notes_payload, inst, label)
            await asyncio.sleep(0.12)

        if not play_sound:
            return f"Showing {played} on {inst} Note Board."

        await self._publish_session_action({
            "action": "PLAY_NOTE_SEQUENCE",
            "notes": notes_payload,
            "coach_notes": label,
            "instrument": inst,
        })
        logger.info("Teaching notes → %s on %s", played, inst)

        # Brief pause so the sample starts before the spoken reply, but never
        # long enough to block the tool call and trigger interruption timeouts.
        await asyncio.sleep(min(0.6, sum(n["duration_ms"] for n in notes_payload) / 1000))

        inst_label = {
            "piano": "piano",
            "guitar": "guitar",
            "both": "piano and guitar",
        }.get(inst, inst)
        if invite_to_sing:
            return (
                f"[The {inst_label} sample for {played} is playing on the student's "
                "speakers — do NOT replay it.] Say ONE short warm line in English "
                "inviting them to sing it back, e.g. 'Now you try — match what you "
                "heard.' Under 2 sentences."
            )
        return (
            f"[Played {played} on {inst} through the student's speakers — do NOT "
            "replay it.] Confirm briefly in English; never say audio is unavailable."
        )

    async def handle_user_play_request(
        self, pitch: str, instrument: str = "piano"
    ) -> None:
        """Execute play/show when user explicitly asks — do not rely on LLM alone."""
        session = self._session_ref.get("session")
        if session:
            session.interrupt()

        try:
            chord_names = try_parse_chord_or_notes(pitch)
            if chord_names:
                notes_payload = build_notes_payload(chord_names, seconds_per_note=0.9)
                note_name = ", ".join(chord_names)
                hz = note_to_hz(chord_names[0])
            elif "," in pitch:
                names = parse_note_list(pitch)
                notes_payload = build_notes_payload(names)
                note_name, hz = names[0], note_to_hz(names[0])
            else:
                note_name, hz = parse_pitch_input(pitch)
                notes_payload = build_notes_payload([note_name])
        except ValueError as exc:
            logger.warning("Invalid USER_PLAY_REQUEST pitch=%s: %s", pitch, exc)
            return

        inst = instrument if instrument in ("piano", "guitar", "both") else "piano"
        await self._teach_with_notes(
            notes_payload,
            instrument=inst,
            coach_notes=f"Playing {note_name} ({hz:.0f} Hz) on {inst}",
            show_on_board=True,
            play_sound=True,
            invite_to_sing=True,
        )

        chat_ctx = self.chat_ctx.copy()
        chat_ctx.add_message(
            role="system",
            content=(
                f"[USER PLAY REQUEST COMPLETED] Piano/guitar audio for {note_name} "
                f"({hz:.0f} Hz) played through the student's speakers and shown on "
                f"the {inst} board. Confirm the sample played — NEVER say you "
                "cannot play piano or that audio is unavailable.\n\n"
                f"{ENGLISH_ONLY_RULE}"
            ),
        )
        await _commit_chat_ctx(self, chat_ctx)
        logger.info("USER_PLAY_REQUEST fulfilled: %s on %s", note_name, inst)

    @llm.function_tool(
        description=(
            "Control the student's session playback and display coaching tips "
            "in their Coach Messages panel. Use PAUSE_TRACK to stop the "
            "backing track, RESUME_TRACK to continue from where it paused, "
            "RESTART_TRACK to start the song from the beginning (use when the "
            "student says 'play again' or 'start over'), or SHOW_TIPS to display "
            "a text-only coaching message without affecting playback or speaking."
        )
    )
    async def control_session_playback(
        self,
        action: str,
        coach_notes: str,
    ) -> str:
        """
        Args:
            action: The playback control action. Must be one of: PAUSE_TRACK, RESUME_TRACK, RESTART_TRACK, SHOW_TIPS.
            coach_notes: A short coaching note or tip to display to the student in the UI alongside the action.
        """
        if action not in ("PAUSE_TRACK", "RESUME_TRACK", "RESTART_TRACK", "SHOW_TIPS"):
            return f"Unknown action {action!r}. Use PAUSE_TRACK, RESUME_TRACK, RESTART_TRACK, or SHOW_TIPS."
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
            "Coach Messages panel WITHOUT speaking or pausing playback. "
            "Use while the student is actively singing in karaoke or "
            "conversational non-interrupt mode. Examples: 'Louder', 'Sharp ↑', "
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
            "Play a reference sine tone on the student's speakers. Prefer "
            "`play_note` for note requests. Provide note_name (e.g. G3, A, A4) "
            "OR frequency_hz for a syllable correction."
        )
    )
    async def play_reference_tone(
        self,
        note_name: str = "",
        frequency_hz: float = 0,
        syllable: str = "",
        duration_seconds: float = 1.2,
        instrument: str = "both",
        invite_to_sing: bool = False,
    ) -> str:
        """
        Args:
            note_name: Note to play, e.g. G3, A, A4 (bare letter defaults to octave 4).
            frequency_hz: Pitch in Hz — used when note_name is not given.
            syllable: Optional syllable label for karaoke corrections.
            duration_seconds: How long to play the tone (default 1.2s).
        """
        resolved_name = ""
        hz = frequency_hz
        if note_name:
            resolved_name = normalize_note_name(note_name)
            hz = note_to_hz(resolved_name)
        elif hz > 0:
            resolved_name = hz_to_note_name(hz)
        else:
            return "Provide note_name (e.g. G3) or frequency_hz."

        label = syllable or resolved_name
        inst = instrument if instrument in ("piano", "guitar", "both") else "piano"
        notes_payload = [{
            "note_name": resolved_name,
            "frequency_hz": round(hz, 2),
            "duration_ms": int(duration_seconds * 1000),
        }]
        if note_name or invite_to_sing:
            return await self._teach_with_notes(
                notes_payload,
                instrument=inst,
                coach_notes=f"Listen: {label} ({hz:.0f} Hz)",
                pause_track=bool(note_name or invite_to_sing),
                show_on_board=True,
                play_sound=True,
                invite_to_sing=invite_to_sing,
            )
        await self._publish_session_action({
            "action": "PLAY_REFERENCE_TONE",
            "frequency_hz": hz,
            "syllable": syllable or resolved_name,
            "note_name": resolved_name,
            "duration_ms": int(duration_seconds * 1000),
            "coach_notes": f"Listen: {label} ({hz:.0f} Hz)",
            "instrument": inst,
        })
        await asyncio.sleep(duration_seconds + 0.25)
        return f"Played {resolved_name} ({hz:.0f} Hz)"

    @llm.function_tool(
        description=(
            "PRIMARY teaching tool — plays REAL piano/guitar audio in the browser. "
            "You CAN and MUST use this when the student asks to play/hear a note, "
            "scale, or pitch. For chords use play_chord. Never refuse or say audio "
            "is unavailable. Accepts G3, A, 440 Hz, C4,D4,E4, etc."
        )
    )
    async def teach_pitch(
        self,
        pitch: str,
        show_on_piano: bool = True,
        play_sound: bool = True,
        instrument: str = "piano",
        coach_notes: str = "",
        invite_to_sing: bool = True,
        seconds_per_note: float = 1.2,
    ) -> str:
        """
        Args:
            pitch: Note(s) or Hz — e.g. G3, A, 440, or C4,D4,E4 for a scale.
            show_on_piano: Highlight key(s) on the Note Board.
            play_sound: Play piano/guitar sample through speakers.
            instrument: piano, guitar, or both for board + audio.
            coach_notes: Label shown in the UI.
            invite_to_sing: After playing, invite student to sing along.
            seconds_per_note: Duration per note when playing.
        """
        if "," in pitch:
            names = parse_note_list(pitch)
            notes_payload = build_notes_payload(names, seconds_per_note)
            return await self._teach_with_notes(
                notes_payload,
                instrument=instrument,
                coach_notes=coach_notes,
                show_on_board=show_on_piano,
                play_sound=play_sound,
                invite_to_sing=invite_to_sing and play_sound,
            )

        try:
            note_name, hz = parse_pitch_input(pitch)
        except ValueError as exc:
            return str(exc)

        notes_payload = [{
            "note_name": note_name,
            "frequency_hz": round(hz, 2),
            "duration_ms": int(seconds_per_note * 1000),
        }]
        return await self._teach_with_notes(
            notes_payload,
            instrument=instrument,
            coach_notes=coach_notes or f"Teaching {note_name} ({hz:.0f} Hz)",
            show_on_board=show_on_piano,
            play_sound=play_sound,
            invite_to_sing=invite_to_sing and play_sound,
        )

    @llm.function_tool(
        description=(
            "Show note(s) on the piano/guitar Note Board WITHOUT playing audio. "
            "Use when explaining where a note lives on the keyboard during a lesson."
        )
    )
    async def show_notes_on_piano(
        self,
        notes: str,
        instrument: str = "piano",
        coach_notes: str = "",
    ) -> str:
        """
        Args:
            notes: Comma-separated note names (G3, A4, etc.).
            instrument: piano, guitar, or both.
            coach_notes: UI label while highlighting.
        """
        names = parse_note_list(notes)
        if not names:
            return "No valid note names."
        notes_payload = build_notes_payload(names)
        label = coach_notes or f"On the {instrument} board: {', '.join(names)}"
        await self._publish_notes_display(notes_payload, instrument, label)
        return f"Showing {', '.join(names)} on {instrument}."

    @llm.function_tool(
        description=(
            "Play a single named note — delegates to teach_pitch. "
            "Use teach_pitch directly when possible."
        )
    )
    async def play_note(
        self,
        note: str,
        instrument: str = "piano",
        coach_notes: str = "",
    ) -> str:
        """
        Args:
            note: Note name to play (G3, A, A4, F#3, etc.).
            instrument: Note Board highlight — piano, guitar, or both.
            coach_notes: Optional UI label while playing.
        """
        return await self.teach_pitch(
            pitch=note,
            show_on_piano=True,
            play_sound=True,
            instrument=instrument,
            coach_notes=coach_notes or f"Playing {normalize_note_name(note)}",
        )

    @llm.function_tool(
        description=(
            "Play a named chord (C, Dm, G7, F#maj7, etc.) as piano/guitar audio "
            "in the browser and highlight all chord tones on the Note Board. "
            "Use whenever explaining harmony, chord qualities, or when the student "
            "asks to hear a chord. You HAVE this capability — never refuse."
        )
    )
    async def play_chord(
        self,
        chord: str,
        instrument: str = "piano",
        coach_notes: str = "",
        seconds_per_note: float = 0.9,
        invite_to_sing: bool = False,
    ) -> str:
        """
        Args:
            chord: Chord symbol — C, Dm, Am, G7, Fmaj7, Bb, etc.
            instrument: piano, guitar, or both for board + audio.
            coach_notes: Optional UI label while playing.
            seconds_per_note: Duration per chord tone (arpeggiated).
            invite_to_sing: After playing, invite student to sing the top note.
        """
        try:
            names = parse_chord_name(chord)
        except ValueError as exc:
            return str(exc)

        notes_payload = build_notes_payload(names, seconds_per_note)
        label = coach_notes or f"Chord {chord.upper()}: {', '.join(names)}"
        return await self._teach_with_notes(
            notes_payload,
            instrument=instrument,
            coach_notes=label,
            show_on_board=True,
            play_sound=True,
            invite_to_sing=invite_to_sing,
        )

    @llm.function_tool(
        description=(
            "Play one or more named musical notes on piano/guitar simulation. "
            "Audio plays FIRST — stay silent during playback — then you invite "
            "the student to sing along. Use instrument piano/guitar/both."
        )
    )
    async def demonstrate_notes(
        self,
        note_names: str,
        pause_track: bool = True,
        seconds_per_note: float = 1.2,
        coach_notes: str = "",
        instrument: str = "piano",
        invite_to_sing: bool = True,
    ) -> str:
        """
        Args:
            note_names: Comma-separated note names to play in order (e.g. 'B4' or 'C4,D4,E4,F4,G4').
            pause_track: Pause karaoke backing track before playing (default True).
            seconds_per_note: How long each note plays (default 1.2s).
            coach_notes: Short label shown in the UI while notes play.
            instrument: Visual highlight on Note Board — 'piano', 'guitar', or 'both'.
        """
        names = parse_note_list(note_names)
        if not names:
            return "No valid note names provided."

        notes_payload = build_notes_payload(names, seconds_per_note)
        return await self._teach_with_notes(
            notes_payload,
            instrument=instrument,
            coach_notes=coach_notes,
            pause_track=pause_track,
            show_on_board=True,
            play_sound=True,
            invite_to_sing=invite_to_sing,
        )

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
        await asyncio.sleep(0.15)
        await self._publish_session_action({
            "action": "PLAY_REFERENCE_TONE",
            "frequency_hz": frequency_hz,
            "syllable": syllable,
            "duration_ms": 1400,
        })
        await asyncio.sleep(0.3)

        hint = f" ({lyric_hint})" if lyric_hint else ""
        return (
            f"[Reference tone for '{syllable}'{hint} at {frequency_hz:.0f} Hz is "
            "playing on the student's speakers.] Now sing or hum ONLY the syllable "
            f"'{syllable}' at that pitch — one sustained note, about 1 second, warm "
            "and clear — then invite the student to match you. English only."
        )

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
        await asyncio.sleep(0.4)

        return (
            f"[Reference pitches for the line \"{lyric_text}\" are playing on the "
            "student's speakers.] Now sing this line yourself, clearly and warmly, "
            "syllable by syllable with correct pitch, then ask the student to sing "
            "it back with you. English only."
        )

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
        input_audio_transcription=InputAudioTranscription(
            model="gpt-4o-mini-transcribe",
            language="en",
        ),
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
    instrument_follow_enabled = False
    instrument_follow_instrument = "both"
    current_song: dict | None = None

    async def inject_instrument_follow_context(enabled: bool, instrument: str) -> None:
        if enabled:
            content = (
                f"[INSTRUMENT FOLLOW ON — {instrument}]\n"
                "The student's microphone pitch is mirrored LIVE as piano/guitar "
                "simulation in their browser while they sing. Use the same "
                "instrument setting when playing note samples.\n\n"
                f"{ENGLISH_ONLY_RULE}"
            )
        else:
            content = (
                "[INSTRUMENT FOLLOW OFF]\n"
                "Live piano/guitar mirror is disabled. Only play samples when asked.\n\n"
                f"{ENGLISH_ONLY_RULE}"
            )
        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=content)
        await _commit_chat_ctx(agent, chat_ctx)
        logger.info("Instrument follow context: enabled=%s instrument=%s", enabled, instrument)

    async def inject_audio_capabilities() -> None:
        chat_ctx = agent.chat_ctx.copy()
        _strip_system_messages_with_markers(chat_ctx, ("[AUDIO CAPABILITIES",))
        chat_ctx.add_message(
            role="system",
            content=f"[AUDIO CAPABILITIES ACTIVE]\n{AUDIO_CAPABILITY_BLOCK}\n\n{ENGLISH_ONLY_RULE}",
        )
        await _commit_chat_ctx(agent, chat_ctx)

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
                "6. When the student asks to play/hear/show a pitch, note, chord, or sound, "
                "you MUST call `teach_pitch`, `play_chord`, or `show_notes_on_piano`. "
                "NEVER say you cannot play piano or audio — you CAN via tools. "
                "Play/show FIRST, then explain.\n"
                "7. When the student requests feedback (REQUEST_FEEDBACK), you MAY speak "
                "in full sentences with a detailed critique.\n"
                "8. Do NOT pause playback, play reference tones, or demonstrate unless asked.\n\n"
                f"{ENGLISH_ONLY_RULE}"
            )
        elif mode == "conversational":
            content = (
                "[CONVERSATIONAL MODE ACTIVE]\n"
                "Free-talk mode with no backing track. You may speak normally for coaching.\n"
                f"{AUDIO_CAPABILITY_BLOCK}\n\n"
                f"{ENGLISH_ONLY_RULE}"
            )
        else:
            content = (
                "[KARAOKE MODE ACTIVE]\n"
                "Backing track and syllable-level pitch tracking are enabled.\n"
                f"{AUDIO_CAPABILITY_BLOCK}\n"
                "SILENT COACHING (preferred while student is singing):\n"
                "1. Use `show_visual_cue` for short 1–3 word cues (e.g. 'Louder', "
                "'Sharp ↑', 'Flat ↓', 'Great!', 'Steady') — shown in Coach Messages.\n"
                "2. Use `control_session_playback` with action SHOW_TIPS for longer "
                "text tips WITHOUT pausing the track or speaking.\n"
                "3. Only use PAUSE_TRACK + spoken correction for serious issues "
                "that require stopping the student.\n"
                "4. React to syllable results and live telemetry with silent cues first.\n\n"
                f"{ENGLISH_ONLY_RULE}"
            )

        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=content)
        await _commit_chat_ctx(agent, chat_ctx)
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
            "You will receive syllable-level pitch results as they sing.\n\n"
            f"{ENGLISH_ONLY_RULE}"
        )
        chat_ctx = agent.chat_ctx.copy()
        chat_ctx.add_message(role="system", content=song_context)
        await _commit_chat_ctx(agent, chat_ctx)
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
        await _commit_chat_ctx(agent, chat_ctx)

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
                f"Telemetry ({mode} mode)",
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
            state_content = (
                f"{SESSION_STATE_MARKER}\n"
                f"{telemetry_context}\n"
                f"{AUDIO_CAPABILITY_BLOCK}\n\n"
                f"{ENGLISH_ONLY_RULE}"
            )

            chat_ctx = agent.chat_ctx.copy()
            _strip_system_messages_with_markers(
                chat_ctx, (SESSION_STATE_MARKER, "[LIVE TELEMETRY")
            )
            chat_ctx.add_message(role="system", content=state_content)
            await _commit_chat_ctx(agent, chat_ctx)

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
        await _commit_chat_ctx(agent, chat_ctx)
        logger.info("Injected analysis snapshot")

    @ctx.room.on("data_received")
    def _on_data_received(packet: rtc.DataPacket) -> None:
        nonlocal coaching_mode, non_interrupt_mode
        nonlocal instrument_follow_enabled, instrument_follow_instrument
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
        elif msg_type == "INSTRUMENT_FOLLOW":
            instrument_follow_enabled = bool(message.get("enabled", instrument_follow_enabled))
            instrument_follow_instrument = message.get(
                "instrument", instrument_follow_instrument
            )
            asyncio.create_task(
                inject_instrument_follow_context(
                    instrument_follow_enabled, instrument_follow_instrument
                )
            )
            logger.info(
                "Instrument follow: enabled=%s instrument=%s",
                instrument_follow_enabled,
                instrument_follow_instrument,
            )
        elif msg_type == "USER_PLAY_REQUEST":
            pitch = message.get("pitch", "")
            instrument = message.get("instrument", "piano")
            if pitch:
                asyncio.create_task(agent.handle_user_play_request(pitch, instrument))
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

    await inject_audio_capabilities()

    participant = await ctx.wait_for_participant()
    logger.info("Participant joined: %s", participant.identity)

    await session.generate_reply(
        instructions=_english_reply(
            "Greet the student warmly in English. Introduce yourself as their AI vocal "
            "coach. You CAN play piano and guitar notes and chords on their "
            "speakers and highlight keys on the Note Board — invite them to try "
            "'play G3 on piano' or 'play a C chord'. You monitor pitch during "
            "karaoke. Ask them to press Start Session when ready."
        )
    )
    logger.info("Agent session started for participant %s", participant.identity)


# ---------------------------------------------------------------------------
# Feedback Handler
# ---------------------------------------------------------------------------

async def _handle_request_feedback(session: AgentSession, ctx: JobContext) -> None:
    """Triggered when the student finishes singing and requests feedback."""
    logger.info("Student requested performance feedback.")

    session.interrupt()

    pause_directive = json.dumps({
        "action": "PAUSE_TRACK",
        "coach_notes": "Analyzing session and preparing verbal critique...",
        "reason": "feedback",
    })
    await ctx.room.local_participant.publish_data(
        payload=pause_directive.encode("utf-8"),
        topic="session_control",
        reliable=True,
    )

    await session.generate_reply(
        instructions=_english_reply(
            "The student has completed their singing performance and requested feedback. "
            "Review the syllable-level results and live telemetry from the conversation history. "
            "Name specific syllables that were sharp, flat, quiet, or missed, and what went well. "
            "Give a constructive, encouraging verbal critique with one clear target improvement."
        )
    )

    resume_directive = json.dumps({
        "action": "RESUME_TRACK",
        "coach_notes": "Feedback complete — keep practicing!",
    })
    await ctx.room.local_participant.publish_data(
        payload=resume_directive.encode("utf-8"),
        topic="session_control",
        reliable=True,
    )
    logger.info("Feedback delivered; session playback resumed.")


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

    await session.generate_reply(instructions=_english_reply(correction_instruction))
    logger.info("Barge-in correction dispatched for reason: %s", reason)


# ---------------------------------------------------------------------------
# CLI Bootstrap
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="vocal-coach"))
