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
    AutoSubscribe,
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
        "vocal telemetry (volume in dB and pitch in Hz). "
        "Your job is to:\n"
        "1. Provide encouraging, specific feedback on pitch accuracy, breath "
        "control, and volume consistency.\n"
        "2. If you detect a critical vocal fault (volume dropping to silence "
        "or pitch going wildly off target), IMMEDIATELY interrupt, explain "
        "what went wrong, and guide the student to correct it.\n"
        "3. Use the `control_session_playback` tool to pause or resume the "
        "backing track and show coaching tips in the UI.\n"
        "4. Keep your spoken responses concise and warm — you are coaching, "
        "not lecturing.\n"
        "5. When the student is doing well, simply let them continue and "
        "offer brief positive reinforcement."
    )

    def __init__(self) -> None:
        super().__init__(instructions=self.SYSTEM_INSTRUCTIONS)

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
        session: AgentSession | None = self.session
        if session is None or session.room is None:
            return "No active room session — cannot dispatch directive."

        directive = json.dumps({"action": action, "coach_notes": coach_notes})
        await session.room.local_participant.publish_data(
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

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    logger.info("Connected to room %s", ctx.room.name)

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

    agent = VocalCoachAgent()
    session = AgentSession(
        llm=openai_realtime,
    )

    # Throttle telemetry injections to avoid flooding the chat context.
    last_telemetry_at = 0.0
    telemetry_lock = asyncio.Lock()
    coaching_mode = "karaoke"

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

            telemetry_context = (
                f"[LIVE TELEMETRY — {mode} mode] Student vocal snapshot — "
                f"Volume: {volume_db:.1f} dB, Pitch: {pitch_hz:.1f} Hz."
            )

            chat_ctx = agent.chat_ctx.copy()
            chat_ctx.add_message(role="system", content=telemetry_context)
            await agent.update_chat_ctx(chat_ctx)

            last_telemetry_at = now
            logger.debug(
                "Injected telemetry: vol=%.1f dB, pitch=%.1f Hz, mode=%s",
                volume_db,
                pitch_hz,
                mode,
            )

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

    participant = await ctx.wait_for_participant()
    await session.start(
        room=ctx.room,
        agent=agent,
    )

    await session.generate_reply(
        instructions=(
            "Greet the student warmly. Introduce yourself as their AI vocal "
            "coach. Let them know you'll be monitoring their pitch and volume "
            "in real time and will jump in with tips whenever needed. "
            "Ask them to start singing whenever they're ready."
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
            "Analyze the vocal metrics (volume in dB and pitch in Hz) from the conversation history. "
            "Give them a constructive, encouraging verbal critique. "
            "State what went well and name one target improvement detail."
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
    logger.warning("CRITICAL VOCAL ERROR received: %s", reason)

    # 1 ▸ Interrupt current agent output
    session.interrupt()

    # 2 ▸ Pause the client-side track immediately
    pause_directive = json.dumps({
        "action": "PAUSE_TRACK",
        "coach_notes": f"Critical issue detected: {reason}. Pausing for correction.",
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
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
