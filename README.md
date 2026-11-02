# Roommate

> Turn shared Twitch reactions into temporary, invite-only rooms for viewers who feel the same.

Roommate is a real-time Twitch community prototype built for the TwitchCon Codex Challenge. It listens to one channel's chat, detects meaningful reactions around live moments, identifies compatible viewers, and offers them an optional room without taking them away from the stream.

**Live backend:** [talk-rooms-6x2v.onrender.com](https://talk-rooms-6x2v.onrender.com/)

**Promotional page:** [talk-rooms-6x2v.onrender.com/welcome.html](https://talk-rooms-6x2v.onrender.com/welcome.html)

## Why Roommate?

Twitch chat creates a powerful shared atmosphere, but it is primarily a many-to-one conversation aimed at the streamer. When chat moves quickly, viewers who share a specific opinion rarely discover one another. Their messages appear for a few seconds and disappear into the feed.

Roommate adds a viewer-to-viewer layer around the existing chat. It does not replace Twitch chat and it does not create rooms from every repeated phrase or emote. It looks for coherent reactions expressed by several distinct viewers—for example:

- disappointment about a character or strategy choice;
- excitement after a clutch play;
- frustration with an interruption or stream event;
- disagreement about a decision made on stream.

When a meaningful topic is confirmed, matched viewers receive an invitation such as **“Justice for Brim”** or **“The Forever Car Bet.”** Joining is always optional.

## Viewer experience

1. A viewer watches and chats normally on Twitch.
2. Roommate receives the channel's chat messages through Twitch EventSub.
3. A fast local pipeline filters spam and groups related reactions.
4. A bounded LLM review decides whether a candidate is meaningful and produces a clear title and viewpoints.
5. Viewers who participated in the same topic receive an invitation over the Twitch video.
6. Invited viewers may join a temporary room, continue watching, and talk with one another.
7. Viewers can dismiss, leave, mute, or report the room at any time.

Rooms are restricted to one stream, invitation-only, short-lived, and never auto-join a viewer.

## Architecture

```text
Twitch channel chat
        │
        ▼
EventSub WebSocket adapter
        │
        ├── delivery deduplication
        ├── command, spam, duplicate, and emote filtering
        └── bounded message processing
        │
        ▼
Incremental local topic detection
        │
        ├── rolling time window
        ├── viewer diversity
        ├── semantic similarity
        ├── coherence and duplicate penalties
        └── fresh-evidence confirmation
        │
        ▼
Bounded Groq review (openai/gpt-oss-120b)
        │
        ├── approve or veto room creation
        ├── generate a room title
        └── identify supported viewpoints
        │
        ▼
Same-stream viewer matcher
        │
        ▼
Temporary room service on Render
        │
        ▼
Twitch Video Fullscreen Extension
```

Raw chat is not sent to an LLM message by message. The local path handles the full stream, while Groq receives only compact candidates containing a small number of short supporting messages. A latest-only scheduler, cooldown, rolling request limit, token budget, and 429 backoff keep model usage bounded.

## Technology

- **OpenAI Codex** — research, architecture, implementation, debugging, testing, deployment, and documentation.
- **Twitch EventSub WebSockets** — real-time `channel.chat.message` ingestion.
- **Twitch Extensions** — viewer invitations and rooms over the Twitch video.
- **Twitch Extension Helper** — authorization callbacks and identity-sharing consent.
- **Twitch JWT authentication** — signed viewer, role, expiry, and channel verification.
- **Groq with `openai/gpt-oss-120b`** — selective topic review, viewpoint extraction, and room naming.
- **Node.js 22** — backend, detector, matcher, room service, and static frontend server.
- **HTML, CSS, and JavaScript** — dependency-light Extension and Signal Lab interfaces.
- **Render** — public HTTPS backend hosting.
- **GitHub** — source control and deployment integration.
- **Optional Hugging Face Transformers / MiniLM** — local semantic embeddings; a hashing embedder is available for fast or resource-constrained deployments.

## Repository structure

```text
public/
  index.html                 Signal Lab and Twitch overlay markup
  styles.css                 Dashboard and overlay styling
  app.js                     Extension identity, invitations, and room UI
  welcome.html               Promotional landing page
  welcome.css
  welcome.js
src/
  server.js                  HTTP API, SSE, static hosting, and orchestration
  twitch-eventsub-adapter.js Twitch authentication and EventSub connection
  detector.js                Filtering, clustering, and topic lifecycle
  embedders.js               Hashing and optional MiniLM embeddings
  llm-analyzer.js            Groq/OpenAI candidate review
  latest-only-scheduler.js   Bounded model scheduling
  matcher.js                 Same-topic, same-stream viewer matching
  chatroom-service.js        Invitations, membership, messages, and safety
  extension-auth.js          Twitch Extension JWT verification
  cors.js                    Twitch Extension origin policy
  scenarios.js               Deterministic demonstration fixtures
test/
  detector.test.js           Detector, Twitch, LLM, rooms, JWT, and CORS tests
```

## Run locally

Roommate requires **Node.js 22 or newer**.

```bash
npm install
npm start
```

Open [http://localhost:4318](http://localhost:4318). With the example configuration, the Signal Lab can replay included chat moments without Twitch credentials.

For an immediate offline smoke test, use the hashing embedder:

```powershell
$env:EMBEDDER="hash"
npm start
```

## Connect a real Twitch chat

1. Copy `.env.example` to `.env`.
2. Create a Twitch developer application and obtain its Client ID.
3. Generate a user access token containing `user:read:chat`.
4. Choose the Twitch channel Roommate should monitor.
5. Start the server.

```ini
CHAT_INPUT_MODE=twitch
TWITCH_CLIENT_ID=your_client_id
TWITCH_USER_ACCESS_TOKEN=your_user_access_token
TWITCH_BROADCASTER_LOGIN=target_channel_login
EMBEDDER=hash
```

`TWITCH_BROADCASTER_ID` is optional and normally resolved from the login. `TWITCH_USER_ID` is normally derived by validating the access token. Do not set it to the target streamer's ID.

The status endpoint reports the current connection without exposing the token:

```text
GET /api/input
```

## Enable Groq review

```ini
LLM_PROVIDER=groq
GROQ_API_KEY=your_groq_key
GROQ_MODEL=openai/gpt-oss-120b
GROQ_REASONING_EFFORT=low
LLM_MIN_INTERVAL_MS=30000
LLM_MAX_REQUESTS_PER_MINUTE=2
LLM_TOKEN_BUDGET_PER_MINUTE=6000
LLM_MAX_OUTPUT_TOKENS=600
```

When an LLM key is configured, a topic must pass the local quality gate and receive model approval before invitations are created. Model responses must reference a current topic version and real supporting message IDs; stale or unsupported output is rejected.

## Twitch Extension setup

Roommate's frontend switches to Extension mode when loaded inside Twitch. In that mode the dashboard is hidden and the viewer sees only identity consent, invitations, and the temporary room drawer.

Recommended Twitch console settings:

| Setting | Value |
|---|---|
| Type | Video – Fullscreen |
| Request Identity Link | Yes |
| Chat Capabilities | No |
| Configuration | No configuration |
| Viewer path | `index.html` |
| URL-fetching allowlist | Your Render HTTPS origin |

Upload `index.html`, `styles.css`, and `app.js` at the root of one ZIP, move the version to Hosted Test, add testing accounts, then install and activate it on the channel being monitored.

Production backend settings:

```ini
TWITCH_EXTENSION_SECRET=base64_secret_from_twitch
TWITCH_EXTENSION_ORIGINS=https://YOUR_EXTENSION_ID.ext-twitch.tv
ALLOW_PREVIEW_IDENTITY=false
ENABLE_SIGNAL_LAB=false
```

The broadcaster channel monitored by EventSub must match the `channel_id` in the Extension viewer JWT. See [TWITCH_EXTENSION_SETUP.md](./TWITCH_EXTENSION_SETUP.md) for the complete walkthrough.

## Authentication and safety

- The Extension sends its latest Twitch JWT with every viewer-specific request.
- The backend verifies the HS256 signature, expiration, role, channel, and linked user ID.
- Unlinked viewers must explicitly approve Twitch identity sharing before receiving personalized invitations.
- Uninvited viewers cannot join a room.
- A viewer must join before posting.
- Messages are limited to 280 characters and sending is rate-limited.
- Room history and moderation reports are bounded in memory.
- Viewers can dismiss an invitation, leave, mute a topic, or report a room.
- Rooms expire automatically and disappear on a server restart in the current prototype.

Never put `TWITCH_EXTENSION_SECRET`, OAuth tokens, or API keys in browser code or source control. `.env` and credential files are excluded by `.gitignore`.

## API overview

| Endpoint | Purpose |
|---|---|
| `GET /api/input` | EventSub connection status |
| `GET /api/identity` | Verify the current Extension JWT |
| `GET /api/viewer/state` | Return only rooms available to the verified viewer |
| `POST /api/rooms/:id/join` | Join an invited room |
| `POST /api/rooms/:id/messages` | Send a room message |
| `POST /api/rooms/:id/leave` | Leave a room |
| `POST /api/rooms/:id/dismiss` | Dismiss an invitation |
| `POST /api/rooms/:id/mute` | Mute the topic temporarily |
| `POST /api/rooms/:id/report` | Report and hide a room |

Signal Lab endpoints, fixtures, manual ingestion, and the public event stream are disabled when `ENABLE_SIGNAL_LAB=false`.

## Tests and benchmark

```bash
npm test
npm run benchmark
```

The automated suite covers filtering, fresh-evidence promotion, EventSub redelivery, Twitch subscription setup, bounded LLM scheduling, citation validation, same-stream matching, invitation enforcement, room controls, JWT verification, and CORS policy.

The synthetic benchmark pushes 10,000 messages through a bounded queue to make overload behavior measurable rather than silently accumulating unlimited work.

## Current prototype limitations

- Rooms and reports are stored in memory and are lost when the service restarts.
- Twitch user access tokens are not automatically refreshed.
- Hosted Extension activation requires the broadcaster's participation.
- The current moderation workflow records reports but does not yet provide a persistent broadcaster review dashboard.
- Similarity thresholds are tuned for an English-language prototype and should become channel- and language-aware.
- A production release needs a finalized privacy policy and retention policy.

## Built with Codex

Codex was used throughout the complete development loop: researching Twitch constraints, exploring the product idea, designing the hybrid local/LLM pipeline, implementing EventSub ingestion, building the viewer matcher and room service, creating the Extension UI, debugging model-rate limits, adding authentication and tests, preparing Render deployment, and documenting the project for submission.

## Vision

Roommate is not another global chat server. It is a temporary social layer built around the moment everyone is already watching. The goal is to let a reaction that would normally disappear in seconds become a small, timely connection between viewers.
