import { NextResponse } from "next/server";
import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

const AGENT_NAME = "vocal-coach";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const room = searchParams.get("room") || "coaching-room";
  const identity =
    searchParams.get("identity") ||
    `student-${Math.floor(Math.random() * 10000)}`;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json(
      {
        error:
          "LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and NEXT_PUBLIC_LIVEKIT_URL must be configured",
      },
      { status: 500 }
    );
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();

    // Explicit dispatch via API (works for new and existing rooms).
    // listDispatch returns 404 when the room does not exist yet — never gate
    // createDispatch on it for fresh per-session room names.
    const httpUrl = livekitUrl.replace(/^wss?:\/\//, "https://");
    const dispatchClient = new AgentDispatchClient(httpUrl, apiKey, apiSecret);

    try {
      let hasCoach = false;
      try {
        const existingDispatches = await dispatchClient.listDispatch(room);
        hasCoach = existingDispatches.some(
          (d) => d.agentName === AGENT_NAME
        );
      } catch (listErr: unknown) {
        const message =
          listErr instanceof Error ? listErr.message : String(listErr);
        // Room not created yet — proceed to createDispatch.
        if (!message.includes("does not exist") && !message.includes("404")) {
          throw listErr;
        }
      }

      if (!hasCoach) {
        await dispatchClient.createDispatch(room, AGENT_NAME, {
          metadata: JSON.stringify({ participant: identity }),
        });
        console.log(`[token] Dispatched ${AGENT_NAME} to room: ${room}`);
      } else {
        console.log(
          `[token] ${AGENT_NAME} already dispatched to room: ${room}`
        );
      }
    } catch (dispatchErr: unknown) {
      const message =
        dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      console.warn("[token] Agent dispatch warning:", message);
      return NextResponse.json(
        { error: `Agent dispatch failed: ${message}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ token, room });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
