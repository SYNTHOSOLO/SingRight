import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const room = searchParams.get("room") || "coaching-room";
  const identity =
    searchParams.get("identity") ||
    `student-${Math.floor(Math.random() * 10000)}`;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      {
        error:
          "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be configured in environment variables",
      },
      { status: 500 }
    );
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, { identity });

    // roomAgentDispatch tells the LiveKit server to dispatch the named agent
    // "vocal-coach" exactly ONCE when this participant joins — no duplicates.
    (at as any).grants = {
      video: {
        roomJoin: true,
        room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        roomAgentDispatch: {
          agentName: "vocal-coach",
          metadata: JSON.stringify({ participant: identity }),
        },
      },
    };

    const token = await at.toJwt();

    return NextResponse.json({ token });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
