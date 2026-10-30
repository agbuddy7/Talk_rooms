# SideChat — Codex x TwitchCon readiness audit

Audit date: October 30, 2026

Official sources: [challenge page](https://twitchcon-codex.devpost.com/), [rules](https://twitchcon-codex.devpost.com/rules), and [resources/FAQ](https://twitchcon-codex.devpost.com/resources).

## Deadline and baseline eligibility

- Submission deadline: November 2, 2026 at 2:00 PM Pacific Time. Use the Devpost countdown as the final authority.
- The project must be new during the submission period.
- It must be an interactive experience for Twitch streamers or their communities, built with Codex, and connected to Twitch through chat, EventSub, an API, overlay, or Extension.

SideChat passes the product-theme and Twitch-connection baseline: it ingests real `channel.chat.message` events through EventSub and turns same-stream chat activity into temporary viewer rooms. Preserve evidence that it was built during the submission period.

## Required submission items

| Requirement | Current status | Action |
| --- | --- | --- |
| Working Twitch-connected project | Pass | Keep the live EventSub demo stable. |
| Repository URL with source, assets, and run instructions | Blocked | This folder is not a Git repository. Initialize it, add a safe `.gitignore`, verify secrets are excluded, and publish it. |
| English project description explaining features and Codex use | Partial | Convert the prototype README into judge-facing copy. |
| Codex session ID | Missing | Record the session ID for this primary build thread. |
| Public YouTube demo under three minutes | Missing | Script, record, edit, upload, and verify public visibility. |
| Video shows the project functioning on Twitch | Partial | Record a real stream/chat feeding SideChat and a room invitation appearing. A Twitch-facing overlay or Extension view would make this much stronger. |
| Video shows how Codex was used | Missing | Include a short Codex build-history segment. |
| Free access for judging through the judging period | Missing | Provide reproducible local setup or a stable hosted demo, plus test credentials/instructions where permitted. |
| Authorized third-party integrations | Partial | Document Twitch, Groq, model, and open-source dependencies and licenses. |

## Judging-criteria audit

The four Stage Two criteria are equally weighted.

### 1. Innovation / Idea — strong

SideChat changes the social graph from streamer-to-viewer into momentary viewer-to-viewer communities formed from live context. Automatic topic and viewpoint discovery is meaningfully different from a generic poll, chatbot, or permanent Discord channel.

To strengthen the pitch, describe it as: **“an ephemeral social layer that turns one fast Twitch chat into small, consent-based conversations around the moment viewers are already reacting to.”**

### 2. Potential Impact — strong concept, evidence needed

The product addresses a real problem: individual opinions disappear in high-volume chat. Real EventSub input and automatic rooms demonstrate value, but the submission should show concrete proof.

Add demo evidence for:

- time from the first coherent burst to topic detection;
- time to room invitation;
- number of viewers matched;
- spam/repetition rejected;
- rooms expiring and never auto-joining viewers.

### 3. Technological Implementation — good prototype, needs hardening

Already implemented:

- real Twitch EventSub ingestion and deduplication;
- bounded local preprocessing and clustering;
- fresh-evidence confirmation;
- Groq structured review with evidence IDs;
- rolling request/token budgets and 429 backoff;
- same-stream, same-topic matching;
- invitation-only room membership;
- automated tests and an overload benchmark.

Highest-value gaps:

- no repository or CI;
- no production deployment path;
- live configuration currently uses the hashing fallback rather than the semantic MiniLM model;
- preview identity is not Twitch Extension JWT identity;
- no persisted moderation/reporting controls;
- the benchmark reports queue behavior but not realistic throughput or end-to-end latency percentiles.

### 4. Design — Twitch-native prototype implemented

The dashboard remains available for judges, and the front end now has a Twitch Extension mode with:

- a compact invitation floater over the stream;
- explicit identity-sharing and one-click consent to join;
- a temporary room drawer that does not obscure the video;
- clear invitation context;
- dismiss, mute, leave, and report controls;
- backend-verified Twitch Extension JWT identity.

Remaining design work is Twitch console registration, hosted HTTPS testing, and final polish using the actual Twitch player.

## Performance benchmark needed

The challenge does not publish fixed latency or throughput thresholds. The current synthetic benchmark sends 10,000 messages as a single immediate burst and demonstrates bounded overload by dropping 5,500 queued messages; that is useful engineering evidence but weak headline material.

Create a realistic benchmark with controlled rates and report:

- sustained messages per second at 50, 100, 250, and 500 msg/s;
- p50/p95 ingestion-to-detection latency;
- queue-drop percentage;
- Groq requests and reserved tokens per minute;
- false-positive/false-negative results on labeled chat scenarios;
- time from hot topic to invitation-ready room.

Suggested demo targets, not official requirements:

- p95 local detection under 2 seconds after enough evidence exists;
- zero drops at 100 msg/s on the demo machine;
- no more than two Groq calls per minute;
- emote/catchphrase storms create zero rooms;
- a coherent five-viewer burst creates an invitation within 10 seconds when Groq capacity is available.

## Ordered execution plan

### P0 — submission safety and reproducibility

1. Initialize Git safely and exclude `.env`, tokens, caches, logs, and model artifacts.
2. Correct the README; it currently lists EventSub as unfinished even though it is implemented.
3. Add a clean first-run path and judge checklist.
4. Record the Codex session ID.

### P1 — Twitch-native experience

1. Build the compact invitation floater and room drawer.
2. Package it as a Twitch Extension overlay/panel or demonstrate it visibly beside the Twitch player.
3. Replace preview identity with verified Twitch identity for the production path.
4. Add dismiss, leave, mute, and report interactions.

### P2 — measurable technical proof

1. Replace the burst-only benchmark with a rate-controlled latency benchmark.
2. Add labeled scenarios for shared reactions, opposing opinions, spam, harassment, and unrelated collisions.
3. Add CI for tests and benchmarks.
4. Produce a concise architecture and privacy diagram for the submission.

### P3 — submission package

1. Write the Devpost description around the four judging criteria.
2. Script a demo under 2:45 so there is margin below the three-minute cap.
3. Record real Twitch ingestion, a live topic, a Groq-approved room, joining, messaging, and expiry.
4. Show Codex briefly and explain what it built.
5. Upload publicly to YouTube, test the repository from a clean machine, submit early, and verify the project is marked **Submitted**, not merely saved.

## Recommended next action

Start with P0, then immediately build the Twitch-native invitation floater. The project already has enough backend depth; the largest judging gain now comes from reproducibility and a watchable on-Twitch experience.
