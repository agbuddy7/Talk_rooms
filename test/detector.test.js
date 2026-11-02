import test from "node:test";
import assert from "node:assert/strict";
import { HotTopicDetector } from "../src/detector.js";
import { HashingEmbedder } from "../src/embedders.js";
import { LatestOnlyScheduler } from "../src/latest-only-scheduler.js";
import { ViewerMatcher } from "../src/matcher.js";
import { ChatroomService } from "../src/chatroom-service.js";
import { TwitchEventSubAdapter, mapTwitchChatEvent } from "../src/twitch-eventsub-adapter.js";
import { analyzeWithLlm, resolveLlmConfiguration } from "../src/llm-analyzer.js";
import { createExtensionToken, verifyExtensionJwt } from "../src/extension-auth.js";
import { isAllowedCorsOrigin, parseAllowedOrigins } from "../src/cors.js";
import { replayScenario, scenarios } from "../src/scenarios.js";

const options = { embedder: new HashingEmbedder(), minUniqueViewers: 3, minMessages: 4, similarityThreshold: 0.12, hotThreshold: 0.4 };

test("allows Twitch Extension CORS origins and supports an exact allowlist", () => {
  assert.equal(isAllowedCorsOrigin("https://abc123.ext-twitch.tv"), true);
  assert.equal(isAllowedCorsOrigin("https://evil.example.com"), false);
  const configured = parseAllowedOrigins("https://one.ext-twitch.tv, https://two.ext-twitch.tv");
  assert.deepEqual(configured, ["https://one.ext-twitch.tv", "https://two.ext-twitch.tv"]);
  assert.equal(isAllowedCorsOrigin("https://one.ext-twitch.tv", configured), true);
  assert.equal(isAllowedCorsOrigin("https://abc123.ext-twitch.tv", configured), false);
});

test("filters emote storms without producing a topic", async () => {
  const detector = new HotTopicDetector(options);
  await replayScenario(detector, scenarios["emote-storm"], () => {}, 0);
  const state = await detector.flush();
  assert.equal(state.topics.length, 0);
  assert.equal(state.totals.substantive, 0);
  assert.ok(state.totals.filtered >= 8);
});

test("fresh evidence, not repeated analysis, promotes a topic", async () => {
  const base = Date.now();
  const detector = new HotTopicDetector({ ...options, confirmationWindowMs: 1_000 });
  scenarios["character-choice"].messages.slice(0, 6).forEach(([user, text], index) => detector.ingest({ id: "a" + index, userId: user, text, timestamp: base }));
  let state = await detector.flush(base + 100);
  assert.equal(state.topics[0]?.status, "forming");
  assert.equal(detector.analyze(base + 900).topics[0]?.status, "forming");
  scenarios["character-choice"].messages.slice(6).forEach(([user, text], index) => detector.ingest({ id: "b" + index, userId: user, text, timestamp: base + 1_200 }));
  state = await detector.flush(base + 1_300);
  assert.equal(state.topics[0]?.status, "hot");
});

test("detects a fast three-viewer Twitch topic before room matching", async () => {
  const base = Date.now();
  const detector = new HotTopicDetector({
    embedder: new HashingEmbedder(), minUniqueViewers: 3, minMessages: 3,
    similarityThreshold: 0.16, hotThreshold: 0.44, confirmationWindowMs: 800
  });
  detector.ingest({ id: "live-1", userId: "u1", text: "graveyard is the play", timestamp: base });
  detector.ingest({ id: "live-2", userId: "u2", text: "go graveyard now", timestamp: base + 450 });
  detector.ingest({ id: "live-3", userId: "u3", text: "graveyard wins this", timestamp: base + 900 });
  const state = await detector.flush(base + 1_000);
  assert.equal(state.topics.length, 1);
  assert.equal(state.topics[0].status, "hot");
  assert.equal(state.topics[0].uniqueViewers, 3);
});

test("deduplicates EventSub deliveries by message id", async () => {
  const detector = new HotTopicDetector(options);
  const message = { id: "evt-1", userId: "u1", text: "Brim had the better storyline" };
  assert.equal(detector.ingest(message).accepted, true);
  assert.equal(detector.ingest(message).accepted, false);
  await detector.flush();
  assert.equal(detector.analyze().totals.received, 1);
});

test("bounded LLM scheduler keeps only the newest pending snapshot", async () => {
  const seen = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = new LatestOnlyScheduler(async (value) => { seen.push(value); if (value === 1) await gate; return value; });
  scheduler.submit(1); scheduler.submit(2); scheduler.submit(3); release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, [1, 3]);
  assert.equal(scheduler.stats.replaced, 1);
});

test("rejects stale or unsupported LLM labels", async () => {
  const detector = new HotTopicDetector({ ...options, minUniqueViewers: 1, minMessages: 1, confirmationWindowMs: 0 });
  detector.ingest({ id: "m1", userId: "u1", text: "guest keeps interrupting the streamer" });
  await detector.flush();
  const topic = detector.analyze().topics[0];
  detector.applyAnalysis({ topics: [{ id: topic.id, version: topic.version - 1, title: "Wrong", summary: "", viewpoints: [], supportingMessageIds: ["m1"] }] });
  assert.notEqual(detector.analyze().topics[0].title, "Wrong");
  detector.candidateSnapshot();
  detector.applyAnalysis({ topics: [{ id: topic.id, version: topic.version, title: "Guest interruptions", summary: "Viewers dislike repeated interruptions.", viewpoints: [{ label: "Annoyed viewers", supportingMessageIds: ["m1"] }], supportingMessageIds: ["m1"] }] });
  assert.equal(detector.analyze().topics[0].title, "Guest interruptions");
});

test("keeps a local title when the LLM veto returns blank labels", async () => {
  const detector = new HotTopicDetector({ ...options, minUniqueViewers: 1, minMessages: 1, confirmationWindowMs: 0 });
  detector.ingest({ id: "blank-1", userId: "u1", text: "ads interrupted the match" });
  await detector.flush();
  const topic = detector.candidateSnapshot()[0];
  detector.applyAnalysis({ topics: [{
    id: topic.id, version: topic.version, title: "", summary: "", viewpoints: [],
    supportingMessageIds: ["blank-1"], roomRecommended: false, roomTitle: "", reason: ""
  }] });
  assert.ok(detector.analyze().topics[0].title.length > 0);
});

test("creates invitation-only rooms from viewers in the same hot topic", async () => {
  const base = Date.now();
  const detector = new HotTopicDetector({ ...options, confirmationWindowMs: 1_000 });
  scenarios["character-choice"].messages.forEach(([user, text], index) => detector.ingest({
    id: "room-" + index, userId: user, displayName: user, text,
    timestamp: base + (index < 6 ? 0 : 1_200)
  }));
  const state = await detector.flush(base + 1_500);
  const rooms = new ViewerMatcher({ streamId: "stream-1" }).match(detector, state, base + 1_500);
  assert.ok(rooms.length > 0);
  assert.equal(rooms[0].streamId, "stream-1");
  assert.equal(rooms[0].invitationOnly, true);
  assert.ok(rooms[0].members.length >= 2);
  assert.ok(rooms[0].members.every((member) => member.confidence >= 0.55));
  const assignedViewers = rooms.flatMap((room) => room.members.map((member) => member.userId));
  assert.equal(assignedViewers.length, new Set(assignedViewers).size);
  const coolingState = detector.analyze(base + 20_000);
  const persistedRooms = new ViewerMatcher({ streamId: "stream-1" });
  const initialRooms = persistedRooms.match(detector, state, base + 1_500);
  assert.ok(persistedRooms.match(detector, coolingState, base + 20_000).some((room) => room.id === initialRooms[0].id));
});

test("chatrooms enforce invitations and joined membership", () => {
  const service = new ChatroomService({ minMessageIntervalMs: 0 });
  service.sync([{
    id: "room-1", streamId: "stream-1", topicId: "topic-1", topicTitle: "Character choice",
    viewpoint: "Brim", createdAt: new Date(1_000).toISOString(), expiresAt: new Date(60_000).toISOString(),
    members: [{ userId: "maya", displayName: "maya", confidence: 0.9 }]
  }], 2_000);
  assert.throws(() => service.join("room-1", { userId: "stranger" }, 3_000), /not invited/);
  const joined = service.join("room-1", { userId: "maya" }, 3_000);
  assert.equal(joined.joinedMembers.length, 1);
  const room = service.send("room-1", { userId: "maya" }, "Brim deserved that ending", 3_100);
  assert.equal(room.messages.at(-1).text, "Brim deserved that ending");
  assert.throws(() => service.send("room-1", { userId: "stranger" }, "hello", 3_200), /Join the room/);
});

test("verifies Twitch Extension JWT identity and channel", () => {
  const secret = Buffer.from("sidechat-test-secret").toString("base64");
  const token = createExtensionToken({
    exp: Math.floor(Date.now() / 1000) + 60, channel_id: "channel-1",
    opaque_user_id: "U-test", user_id: "maya", role: "viewer", is_unlinked: false
  }, secret);
  const identity = verifyExtensionJwt(token, { secret, channelId: "channel-1" });
  assert.equal(identity.userId, "maya");
  assert.equal(identity.linked, true);
  assert.throws(() => verifyExtensionJwt(token, { secret, channelId: "channel-2" }), /another channel/);
});

test("supports dismiss, leave, mute, and report controls", () => {
  const service = new ChatroomService({ minMessageIntervalMs: 0 });
  const suggestion = {
    id: "room-safe", streamId: "stream-1", topicId: "topic-1", topicTitle: "Live moment",
    viewpoint: "Shared reaction", createdAt: new Date(1_000).toISOString(),
    expiresAt: new Date(1_000_000).toISOString(),
    members: [{ userId: "maya", displayName: "Maya", confidence: 0.9 }]
  };
  service.sync([suggestion], 2_000);
  assert.equal(service.forViewer("maya", 2_000).length, 1);
  service.join("room-safe", { userId: "maya" }, 2_100);
  service.leave("room-safe", { userId: "maya" }, 2_200);
  assert.equal(service.forViewer("maya", 2_300).length, 0);
  service.reset();
  service.sync([suggestion], 2_000);
  const report = service.report("room-safe", { userId: "maya" }, "spam", 2_400);
  assert.equal(report.action, "reported");
  assert.equal(service.reports.length, 1);
  assert.equal(service.forViewer("maya", 2_500).length, 0);
});

test("maps Twitch channel.chat.message events into detector input", () => {
  const frame = {
    metadata: {
      message_id: "envelope-1", message_type: "notification",
      subscription_type: "channel.chat.message", message_timestamp: "2026-10-29T12:00:00Z"
    },
    payload: { event: {
      broadcaster_user_id: "b1", chatter_user_id: "u1", chatter_user_name: "Maya",
      message_id: "m1", message: { text: "Brim deserved that ending", fragments: [{ type: "text", text: "Brim deserved that ending" }] }
    } }
  };
  assert.deepEqual(mapTwitchChatEvent(frame), {
    id: "m1", streamId: "b1", userId: "u1", displayName: "Maya",
    text: "Brim deserved that ending",
    fragments: [{ type: "text", text: "Brim deserved that ending" }],
    timestamp: "2026-10-29T12:00:00Z"
  });
});

test("validates Twitch identity, subscribes, and deduplicates notifications", async () => {
  class MockSocket {
    static instances = [];
    constructor(url) { this.url = url; this.listeners = new Map(); MockSocket.instances.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data }); }
    close() {}
  }
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.includes("/validate")) return { ok: true, json: async () => ({ client_id: "client-1", user_id: "reader-1", scopes: ["user:read:chat"], expires_in: 3600 }) };
    if (url.includes("/users")) return { ok: true, json: async () => ({ data: [{ id: "broadcaster-1", login: "target" }] }) };
    return { ok: true, json: async () => ({ data: [{ id: "subscription-1" }] }) };
  };
  const ingested = [];
  const adapter = new TwitchEventSubAdapter({
    clientId: "client-1", accessToken: "secret", broadcasterLogin: "target",
    fetchImpl, WebSocketImpl: MockSocket, detector: { ingest: (message) => { ingested.push(message); return { accepted: true }; } }
  });
  await adapter.start();
  const socket = MockSocket.instances[0];
  socket.emit("message", JSON.stringify({
    metadata: { message_id: "welcome-1", message_type: "session_welcome" },
    payload: { session: { id: "session-1", keepalive_timeout_seconds: 30 } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const subscriptionRequest = requests.find((request) => request.url.includes("/eventsub/subscriptions"));
  assert.equal(JSON.parse(subscriptionRequest.init.body).transport.session_id, "session-1");
  const notification = JSON.stringify({
    metadata: {
      message_id: "envelope-1", message_type: "notification",
      subscription_type: "channel.chat.message", message_timestamp: "2026-10-29T12:00:00Z"
    },
    payload: { event: {
      broadcaster_user_id: "broadcaster-1", chatter_user_id: "viewer-1",
      chatter_user_name: "Viewer", message_id: "chat-1",
      message: { text: "hello chat", fragments: [] }
    } }
  });
  socket.emit("message", notification);
  socket.emit("message", notification);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ingested.length, 1);
  assert.equal(adapter.getStatus().status, "live");
  adapter.stop();
});

test("uses Groq Responses API with the GPT-OSS 120B model", async () => {
  let request;
  const result = await analyzeWithLlm([], {
    provider: "groq", apiKey: "test-key", model: "openai/gpt-oss-120b",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: JSON.stringify({ topics: [] }) }] }]
        })
      };
    }
  });
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, "https://api.groq.com/openai/v1/responses");
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, undefined);
  assert.deepEqual(result, { topics: [] });
  assert.equal(resolveLlmConfiguration({ provider: "groq", apiKey: "key" }).provider, "groq");
});
