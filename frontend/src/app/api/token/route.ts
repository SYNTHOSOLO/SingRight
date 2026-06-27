import { NextResponse } from "next/server";
import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

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
    // 1. Generate participant access token
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();

    // 2. Only dispatch the agent if there is no existing dispatch for this room.
    //    This prevents duplicate agents when the token endpoint is called multiple times.
    const httpUrl = livekitUrl.replace(/^wss?:\/\//, "https://");
    const dispatchClient = new AgentDispatchClient(httpUrl, apiKey, apiSecret);

    try {
      const existingDispatches = await dispatchClient.listDispatch(room);
      if (existingDispatches.length === 0) {
        // No agent in this room yet — create one dispatch
        await dispatchClient.createDispatch(room, "", {
          metadata: JSON.stringify({ mode: "vocal-coach", participant: identity }),
        });
        console.log(`[token] Agent dispatched to room: ${room}`);
      } else {
        console.log(
          `[token] Agent already dispatched to room: ${room} (${existingDispatches.length} dispatch(es))`
        );
      }
    } catch (dispatchErr: any) {
      // Non-fatal: log but don't block the token from being returned
      console.warn("[token] Agent dispatch warning:", dispatchErr?.message ?? dispatchErr);
    }

    return NextResponse.json({ token });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
