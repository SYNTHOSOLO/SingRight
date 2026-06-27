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

    // 2. Programmatically dispatch the agent to the room via the LiveKit API.
    //    This triggers the backend worker's entrypoint for unnamed agents.
    //    We convert wss:// → https:// for the REST API.
    const httpUrl = livekitUrl.replace(/^wss?:\/\//, "https://");
    const dispatchClient = new AgentDispatchClient(httpUrl, apiKey, apiSecret);
    try {
      // agent_name="" dispatches to any unnamed worker (our agent)
      await dispatchClient.createDispatch(room, "", {
        metadata: JSON.stringify({ mode: "vocal-coach", participant: identity }),
      });
    } catch (dispatchErr: any) {
      // Dispatch might fail if the agent is already in the room — that's fine
      console.warn("Agent dispatch warning:", dispatchErr?.message ?? dispatchErr);
    }

    return NextResponse.json({ token });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
