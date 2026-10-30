import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HotTopicDetector } from "./detector.js";
import { LatestOnlyScheduler } from "./latest-only-scheduler.js";
import { analyzeWithLlm, resolveLlmConfiguration } from "./llm-analyzer.js";
import { ViewerMatcher } from "./matcher.js";
import { ChatroomService } from "./chatroom-service.js";
import { verifyExtensionJwt } from "./extension-auth.js";
import { TwitchEventSubAdapter } from "./twitch-eventsub-adapter.js";
import { replayScenario, scenarios } from "./scenarios.js";

const inputMode = String(process.env.CHAT_INPUT_MODE ?? "replay").toLowerCase();
const liveInput = inputMode === "twitch";
const llmConfiguration = resolveLlmConfiguration();
const llmEnabled = Boolean(llmConfiguration.apiKey);
const extensionSecret = String(process.env.TWITCH_EXTENSION_SECRET ?? "").trim();
const previewIdentityEnabled = process.env.ALLOW_PREVIEW_IDENTITY === "true" || !extensionSecret;
const signalLabEnabled = process.env.ENABLE_SIGNAL_LAB === "true" || !extensionSecret;
const ignoredTokens = [process.env.TWITCH_BROADCASTER_LOGIN].filter(Boolean);
const detector = new HotTopicDetector(liveInput ? {
  ignoredAnchors: ignoredTokens,
  windowMs: 60_000,
  minUniqueViewers: 3,
  minMessages: 3,
  similarityThreshold: 0.16,
  hotThreshold: 0.44,
  confirmationWindowMs: 800,
  maxTopics: 5
} : {});
const matcher = new ViewerMatcher(liveInput ? {
  streamId: process.env.TWITCH_BROADCASTER_ID ?? "live-stream",
  ignoredTokens,
  minMembers: 2,
  maxMembers: 8,
  maxRooms: 3,
  roomTtlMs: 45_000,
  minTopicScore: 0.5,
  minTopicViewers: 4,
  minTopicMessages: 4,
  minTopicCoherence: 0.38,
  maxDuplicatePenalty: 0.28,
  minAverageTokens: 1.25,
  minDetailedMessageRatio: 0,
  requireAnalysis: llmEnabled
} : { streamId: "demo-stream" });
const chatrooms = new ChatroomService();
let twitchAdapter = null;
const replayInputStatus = { mode: "replay", status: "ready", label: "Replay input", messagesReceived: 0, error: null };
const clients = new Set();
const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT ?? 4317);
let publishing = false;
let lastLlmFingerprint = "";
let lastLlmSubmittedAt = 0;
let llmBackoffUntil = 0;
const llmCooldownMs = Number(process.env.LLM_MIN_INTERVAL_MS ?? 30_000);
const llmMaxRequestsPerMinute = Number(process.env.LLM_MAX_REQUESTS_PER_MINUTE ?? 2);
const llmTokenBudgetPerMinute = Number(process.env.LLM_TOKEN_BUDGET_PER_MINUTE ?? 6_000);
const llmUsage = [];
const estimateLlmTokens = (snapshot) => 1_300 + Math.ceil(JSON.stringify(snapshot).length / 4) + 600;
const pruneLlmUsage = (now) => {
  while (llmUsage.length && llmUsage[0].at <= now - 60_000) llmUsage.shift();
};
const llm = llmEnabled ? new LatestOnlyScheduler(
  analyzeWithLlm,
  (result) => { detector.applyAnalysis(result); broadcast("state", enrichState(detector.analyze())); },
  (error) => {
    llmBackoffUntil = Date.now() + (error.retryAfterMs ?? (error.status === 429 ? 60_000 : 30_000));
    console.warn("Topic labeler failed:", error.message);
  }
) : null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function extensionIdentity(request, requireLinked = true) {
  const token = request.headers["x-extension-jwt"];
  if (!token) throw new Error("Twitch Extension authorization is required");
  const channelId = process.env.TWITCH_BROADCASTER_ID ?? twitchAdapter?.getStatus()?.broadcasterUserId;
  const identity = verifyExtensionJwt(token, { secret: extensionSecret, channelId });
  if (requireLinked && !identity.linked) throw new Error("Share your Twitch identity to receive invitations");
  return identity;
}

function viewerForRequest(request, body = {}) {
  if (request.headers["x-extension-jwt"]) {
    const identity = extensionIdentity(request);
    return { userId: identity.userId, displayName: "Twitch viewer", identity };
  }
  if (previewIdentityEnabled && body.userId) {
    return { userId: String(body.userId), displayName: String(body.displayName ?? "Preview viewer"), identity: { mode: "preview" } };
  }
  throw new Error("Verified Twitch viewer identity is required");
}

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function enrichState(state) {
  const suggestions = matcher.match(detector, state);
  return {
    ...state,
    input: twitchAdapter?.getStatus() ?? replayInputStatus,
    rooms: chatrooms.sync(suggestions)
  };
}

async function publishState() {
  if (publishing) return enrichState(detector.lastState);
  publishing = true;
  try {
    const state = enrichState(await detector.flush());
    const now = Date.now();
    pruneLlmUsage(now);
    const requestsAvailable = llmUsage.length < llmMaxRequestsPerMinute;
    const usedTokens = llmUsage.reduce((sum, item) => sum + item.tokens, 0);
    if (llm && now >= llmBackoffUntil && requestsAvailable && now - lastLlmSubmittedAt >= llmCooldownMs) {
      const snapshot = detector.candidateSnapshot(now, liveInput ? {
        maxCandidates: 1, maxMessages: 6, maxMessageCharacters: 180,
        minUniqueViewers: 4, minMessages: 4, minScore: 0.5, minCoherence: 0.38,
        maxDuplicatePenalty: 0.28, minAverageTokens: 1.25,
        minDetailedMessageRatio: 0, minVersionDelta: 5
      } : { maxCandidates: 1, maxMessages: 4, minVersionDelta: 6 });
      const fingerprint = snapshot.map((topic) => topic.id + ":" + topic.version).join("|");
      const estimatedTokens = estimateLlmTokens(snapshot);
      if (snapshot.length && fingerprint !== lastLlmFingerprint && usedTokens + estimatedTokens <= llmTokenBudgetPerMinute) {
        lastLlmFingerprint = fingerprint;
        lastLlmSubmittedAt = now;
        llmUsage.push({ at: now, tokens: estimatedTokens });
        llm.submit(snapshot);
      }
    }
    broadcast("state", state);
    return state;
  } finally {
    publishing = false;
  }
}

setInterval(() => void publishState(), 250).unref();

export const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/state") {
    if (!signalLabEnabled) return sendJson(response, 403, { error: "Signal Lab is disabled in Extension mode" });
    return sendJson(response, 200, enrichState(await detector.flush()));
  }
  if (request.method === "GET" && url.pathname === "/api/input") {
    return sendJson(response, 200, twitchAdapter?.getStatus() ?? replayInputStatus);
  }
  if (request.method === "GET" && url.pathname === "/api/identity") {
    try {
      const identity = extensionIdentity(request, false);
      return sendJson(response, 200, {
        mode: "extension", linked: identity.linked, userId: identity.userId,
        opaqueUserId: identity.opaqueUserId, channelId: identity.channelId, role: identity.role
      });
    } catch (error) {
      return sendJson(response, 401, { error: error.message });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/viewer/state") {
    try {
      const identity = extensionIdentity(request);
      const state = await detector.flush();
      return sendJson(response, 200, {
        generatedAt: state.generatedAt,
        input: twitchAdapter?.getStatus() ?? replayInputStatus,
        rooms: chatrooms.forViewer(identity.userId)
      });
    } catch (error) {
      return sendJson(response, 401, { error: error.message });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/scenarios") {
    if (!signalLabEnabled) return sendJson(response, 403, { error: "Replay scenarios are disabled" });
    return sendJson(response, 200, Object.entries(scenarios).map(([id, value]) => ({ id, name: value.name })));
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    if (!signalLabEnabled) return sendJson(response, 403, { error: "Public event stream is disabled" });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    clients.add(response);
    response.write(`event: state\ndata: ${JSON.stringify(enrichState(detector.analyze()))}\n\n`);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/messages") {
    if (!signalLabEnabled) return sendJson(response, 403, { error: "Manual ingestion is disabled" });
    try {
      const body = await readJson(request);
      const messages = Array.isArray(body) ? body : [body];
      const results = messages.map((message) => detector.ingest(message));
      return sendJson(response, 202, { results, state: await publishState() });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/rooms/")) {
    try {
      const parts = url.pathname.split("/").filter(Boolean);
      const roomId = decodeURIComponent(parts[2] ?? "");
      const action = parts[3];
      const body = await readJson(request);
      const viewer = viewerForRequest(request, body);
      let room;
      if (action === "join") room = chatrooms.join(roomId, viewer);
      else if (action === "messages") room = chatrooms.send(roomId, viewer, body.text);
      else if (action === "dismiss") room = chatrooms.dismiss(roomId, viewer);
      else if (action === "leave") room = chatrooms.leave(roomId, viewer);
      else if (action === "mute") room = chatrooms.mute(roomId, viewer);
      else if (action === "report") room = chatrooms.report(roomId, viewer, body.reason);
      else return sendJson(response, 404, { error: "Unknown room action" });
      if (room?.id) broadcast("room", room);
      return sendJson(response, 200, room);
    } catch (error) {
      return sendJson(response, 403, { error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/simulate/")) {
    if (!signalLabEnabled) return sendJson(response, 403, { error: "Replay scenarios are disabled" });
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    const scenario = scenarios[id];
    if (!scenario) return sendJson(response, 404, { error: "Unknown scenario" });
    sendJson(response, 202, { started: true, id, name: scenario.name });
    replayScenario(detector, scenario, (message) => {
      broadcast("message", message);
      void publishState();
    }).then(() => publishState());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/reset") {
    if (!signalLabEnabled) return sendJson(response, 403, { error: "Signal Lab reset is disabled" });
    detector.reset();
    matcher.reset();
    chatrooms.reset();
    const state = enrichState(detector.lastState);
    broadcast("state", state);
    return sendJson(response, 200, state);
  }
  if (request.method === "GET") {
    const requestedPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = join(publicDirectory, requestedPath);
    if (filePath.startsWith(publicDirectory) && existsSync(filePath)) {
      response.writeHead(200, {
        "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' https://extension-files.twitch.tv; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors https://*.twitch.tv https://*.ext-twitch.tv",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      createReadStream(filePath).pipe(response);
      return;
    }
  }
  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log("SideChat detector running at http://localhost:" + port);
  if (inputMode === "twitch") {
    twitchAdapter = new TwitchEventSubAdapter({
      clientId: process.env.TWITCH_CLIENT_ID,
      accessToken: process.env.TWITCH_USER_ACCESS_TOKEN,
      broadcasterUserId: process.env.TWITCH_BROADCASTER_ID,
      broadcasterLogin: process.env.TWITCH_BROADCASTER_LOGIN,
      userId: process.env.TWITCH_USER_ID,
      detector,
      onMessage: () => void publishState(),
      onStatus: (status) => broadcast("input", status)
    });
    twitchAdapter.start().catch((error) => {
      twitchAdapter.update({ status: "error", label: "Twitch setup failed", error: error.message });
      console.warn("Twitch input failed:", error.message);
    });
  }
});

function shutdown() {
  twitchAdapter?.stop();
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
