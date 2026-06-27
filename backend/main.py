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
import time

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
        "4. Keep your spoken responses concise and warm — you are coaching, "
        "not lecturing.\n"
        "5. When the student is doing well, simply let them continue and "
        "offer brief positive reinforcement."
    )

    def __init__(self, ctx: "JobContext") -> None:
        super().__init__(instructions=self.SYSTEM_INSTRUCTIONS)
        self._ctx = ctx

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

    agent = VocalCoachAgent(ctx=ctx)
    session = AgentSession(
        llm=openai_realtime,
    )

    # Throttle telemetry injections to avoid flooding the chat context.
    last_telemetry_at = 0.0
    telemetry_lock = asyncio.Lock()
    coaching_mode = "karaoke"
    current_song: dict | None = None

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

            telemetry_context = ". ".join(parts) + "."

            chat_ctx = agent.chat_ctx.copy()
            chat_ctx.add_message(role="system", content=telemetry_context)
            await agent.update_chat_ctx(chat_ctx)

            last_telemetry_at = now
            logger.debug("Injected telemetry: %s", telemetry_context)

    @ctx.room.on("data_received")
    def _on_data_received(packet: rtc.DataPacket) -> None:
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
            nonlocal coaching_mode
            coaching_mode = message.get("mode", coaching_mode)
            logger.info("Coaching mode set to %s", coaching_mode)
        elif msg_type == "CRITICAL_ERROR":
            asyncio.create_task(_handle_critical_error(session, ctx, message))
        elif msg_type == "REQUEST_FEEDBACK":
            asyncio.create_task(_handle_request_feedback(session, ctx))
        else:
            logger.debug("Unknown data-channel message type: %s", msg_type)

    # AgentSession connects to the room on start (per LiveKit docs).
    await session.start(
        room=ctx.room,
        agent=agent,
    )
    logger.info("Connected to room %s", ctx.room.name)

    participant = await ctx.wait_for_participant()
    logger.info("Participant joined: %s", participant.identity)

    await session.generate_reply(
        instructions=(
            "Greet the student warmly. Introduce yourself as their AI vocal "
            "coach. Let them know they'll be singing the Alphabet song with "
            "lyrics on screen, and you'll monitor their pitch syllable by "
            "syllable and jump in with tips whenever needed. "
            "Ask them to press Start Session and sing along when ready."
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
) -> None:
    """
    Execute the barge-in interruption pipeline:
    1. Clear any queued / in-progress agent speech.
    2. Dispatch a PAUSE_TRACK directive to freeze the client UI.
    3. Force the model to deliver an immediate spoken correction.
    """
    reason = error.get("reason", "UNKNOWN_FAULT")
    syllable = error.get("syllable")
    expected_hz = error.get("expected_hz")
    actual_hz = error.get("actual_hz")
    logger.warning(
        "CRITICAL VOCAL ERROR received: %s (syllable=%s)", reason, syllable
    )

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
