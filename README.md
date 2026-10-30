# SideChat hot-topic detector

This prototype detects meaningful, fast-moving topics inside one Twitch stream's chat, assigns participating viewers to a local or LLM-supported viewpoint, and produces consent-based room invitations.

## Architecture

~~~text
Twitch EventSub
  -> dedupe + emote/command filter
  -> bounded micro-batch queue
  -> local MiniLM embeddings
  -> incremental decaying microclusters
  -> fresh-evidence confirmation
  -> optional bounded LLM labeler
  -> same-topic viewpoint matcher
  -> temporary invitation-only rooms
  -> Signal Lab dashboard or Twitch Extension overlay
~~~

Raw chat is never sent message-by-message to an LLM. The local path absorbs the full stream. Only small candidate snapshots can reach the optional labeler, which permits one active request and one replaceable pending request.

Important safeguards:

- Event IDs are deduplicated before work is queued.
- The queue has a hard cap and reports dropped work under overload.
- Messages are embedded in batches of up to 32.
- Existing messages are never reclustered on every timer tick.
- A topic becomes hot only after new messages arrive in at least two time buckets; repeated analysis cannot promote stale evidence.
- LLM results must match the current cluster version and cite real message IDs, otherwise they are discarded.
- Identical cluster versions are not resubmitted to the LLM.
- Matching is restricted to viewers in the same detector instance/stream and the same confirmed topic.
- Rooms require at least two distinct viewers, contain at most six, expire after two minutes, and never auto-join anyone.
- Twitch Extension room actions require a signed viewer JWT; the backend verifies its signature, expiry, channel, role, and linked user ID.
- Viewers can dismiss, leave, mute a topic, or report a room.

## Run

Requires Node.js 22 or newer.

~~~powershell
npm install
npm start
~~~

The first semantic run downloads onnx-community/all-MiniLM-L6-v2-ONNX and caches it locally. To run immediately without a model download:

~~~powershell
$env:EMBEDDER="hash"
npm start
~~~

Open http://localhost:4318 and replay the included chat moments.

## Read a real Twitch chat

The application can replace fixture input with read-only EventSub input while keeping the same detector and dashboard.

1. Copy .env.example to .env.
2. Register a Twitch developer application and obtain its Client ID.
3. Authorize your Twitch account with the user:read:chat scope and place the user access token in .env.
4. Set the target channel login.

~~~env
CHAT_INPUT_MODE=twitch
TWITCH_CLIENT_ID=your_client_id
TWITCH_USER_ACCESS_TOKEN=your_user_access_token
TWITCH_BROADCASTER_LOGIN=target_channel_login
EMBEDDER=hash
~~~

Then run npm start and open http://localhost:4318. The status pill moves through authentication and connection states and becomes Live Twitch chat after the EventSub subscription is enabled. Incoming channel.chat.message events enter the same detector used by the replay fixtures.

The access token remains on the backend and is never returned by the API. Do not commit .env or paste the token into chat. The Twitch integration is read-only: it does not post messages or modify the target channel.

## Try a chatroom

After an invitation appears:

1. Choose an invited identity from Preview as invited viewer.
2. Select Join room on that viewer's matched topic.
3. Send messages in the temporary SideChat panel.

The demo backend rejects uninvited joins, requires membership before posting, limits messages to 280 characters, rate-limits sends, retains the latest 100 messages, and expires inactive rooms.

## Twitch Extension overlay

The same front end switches into a transparent overlay when Twitch loads it with Extension iframe parameters. It shows a compact invitation floater and opens a room drawer without covering the whole stream. The Extension Helper JWT is sent to the backend for every viewer-specific read and room action. Unlinked viewers are asked for explicit identity-sharing consent before invitations can be matched to their EventSub chat messages.

See [TWITCH_EXTENSION_SETUP.md](./TWITCH_EXTENSION_SETUP.md) for Twitch console and environment setup. When TWITCH_EXTENSION_SECRET is configured, preview identity, public room state, replay controls, and manual ingestion are disabled unless explicitly enabled for a protected judging build.

## Optional LLM review

The default provider is Groq with openai/gpt-oss-120b. Add GROQ_API_KEY to .env to enable it. Raw chat and visible trend detection remain local. Groq is called only after a topic already meets the stricter room-quality gate. Each request contains one candidate and at most six short evidence messages. The rolling defaults allow at most two requests and reserve at most 6,000 tokens per minute. Groq Structured Outputs may veto a room or return a catchy title, summary, viewpoints, and supporting message IDs. When a key is configured, invitations wait for model approval.

~~~env
LLM_PROVIDER=groq
GROQ_API_KEY=your_local_key
GROQ_MODEL=openai/gpt-oss-120b
GROQ_REASONING_EFFORT=low
LLM_MIN_INTERVAL_MS=30000
LLM_MAX_REQUESTS_PER_MINUTE=2
LLM_TOKEN_BUDGET_PER_MINUTE=6000
LLM_MAX_OUTPUT_TOKENS=600
~~~

OpenAI remains an optional provider by setting LLM_PROVIDER=openai and OPENAI_API_KEY.

## Verify

~~~powershell
npm test
npm run benchmark
~~~

The test suite covers emote storms, EventSub redelivery, fresh-evidence promotion, latest-only LLM scheduling, and stale/citation-invalid LLM output. The benchmark pushes 10,000 messages through a 2,000-item bounded queue to make overload behavior visible.

## HTTP ingestion contract

POST /api/messages accepts one message or an array:

~~~json
{
  "id": "message-123",
  "userId": "viewer-7",
  "displayName": "Viewer7",
  "text": "Brim had the stronger storyline",
  "timestamp": "2026-10-28T12:00:00Z"
}
~~~

A Twitch adapter should map channel.chat.message EventSub payloads into this shape. GET /api/state returns detector state, including queue and batch metrics; GET /api/events streams updates over SSE.

Room actions use POST /api/rooms/:id/join and POST /api/rooms/:id/messages. Both require a viewer identity; the messages endpoint also requires text.

## What remains before Twitch deployment

- Register and host the overlay behind a public HTTPS origin in the Twitch Extensions console.
- Replay recorded, consented chat traces to tune similarity and traffic-adaptive thresholds.
- Add per-channel language/model configuration.
- Persist and review moderation reports instead of keeping only the bounded in-memory demo audit.
- Add a published privacy policy and data-retention statement.
