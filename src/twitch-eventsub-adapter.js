const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const USERS_URL = "https://api.twitch.tv/helix/users";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";

export function mapTwitchChatEvent(frame) {
  if (frame?.metadata?.message_type !== "notification") return null;
  if (frame?.metadata?.subscription_type !== "channel.chat.message") return null;
  const event = frame.payload?.event;
  if (!event?.message_id || !event?.chatter_user_id || !event?.message?.text) return null;
  return {
    id: event.message_id,
    streamId: event.broadcaster_user_id,
    userId: event.chatter_user_id,
    displayName: event.chatter_user_name ?? event.chatter_user_login ?? event.chatter_user_id,
    text: event.message.text,
    fragments: event.message.fragments ?? [],
    timestamp: frame.metadata.message_timestamp ?? Date.now()
  };
}

export class TwitchEventSubAdapter {
  constructor(options = {}) {
    this.options = {
      clientId: options.clientId,
      accessToken: String(options.accessToken ?? "").replace(/^oauth:/i, ""),
      broadcasterUserId: options.broadcasterUserId,
      broadcasterLogin: options.broadcasterLogin,
      userId: options.userId,
      detector: options.detector,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
      onMessage: options.onMessage ?? (() => {}),
      onStatus: options.onStatus ?? (() => {})
    };
    this.socket = null;
    this.stopped = true;
    this.watchdog = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.seenEnvelopeIds = new Map();
    this.state = {
      mode: "twitch", status: "idle", label: "Twitch idle",
      broadcasterUserId: this.options.broadcasterUserId ?? null,
      broadcasterLogin: this.options.broadcasterLogin ?? null,
      messagesReceived: 0, lastEventAt: null, error: null
    };
  }

  getStatus() { return { ...this.state }; }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.options.onStatus(this.getStatus());
  }

  async start() {
    if (!this.options.clientId || !this.options.accessToken) {
      throw new Error("TWITCH_CLIENT_ID and TWITCH_USER_ACCESS_TOKEN are required");
    }
    if (!this.options.WebSocketImpl) throw new Error("This Node.js runtime does not provide WebSocket support");
    this.stopped = false;
    this.update({ status: "authenticating", label: "Authenticating Twitch", error: null });
    await this.resolveIdentity();
    this.connect(EVENTSUB_URL, { createSubscriptions: true });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.update({ status: "stopped", label: "Twitch stopped" });
  }

  async resolveIdentity() {
    const validation = await this.requestJson(VALIDATE_URL, {
      headers: { Authorization: "OAuth " + this.options.accessToken }
    });
    if (validation.client_id !== this.options.clientId) throw new Error("The Twitch token belongs to a different Client ID");
    if (!(validation.scopes ?? []).includes("user:read:chat")) throw new Error("The Twitch token is missing the user:read:chat scope");
    this.options.userId = this.options.userId ?? validation.user_id;
    if (!this.options.broadcasterUserId) {
      if (!this.options.broadcasterLogin) throw new Error("Set TWITCH_BROADCASTER_LOGIN or TWITCH_BROADCASTER_ID");
      const url = USERS_URL + "?login=" + encodeURIComponent(this.options.broadcasterLogin);
      const result = await this.requestJson(url, { headers: this.helixHeaders() });
      const broadcaster = result.data?.[0];
      if (!broadcaster) throw new Error("Twitch channel was not found: " + this.options.broadcasterLogin);
      this.options.broadcasterUserId = broadcaster.id;
      this.options.broadcasterLogin = broadcaster.login;
    }
    this.update({
      broadcasterUserId: this.options.broadcasterUserId,
      broadcasterLogin: this.options.broadcasterLogin,
      tokenExpiresInSeconds: validation.expires_in
    });
  }

  helixHeaders() {
    return {
      Authorization: "Bearer " + this.options.accessToken,
      "Client-Id": this.options.clientId,
      "Content-Type": "application/json"
    };
  }

  connect(url, { createSubscriptions, oldSocket = null }) {
    if (this.stopped) return;
    this.update({ status: "connecting", label: "Connecting Twitch", error: null });
    const socket = new this.options.WebSocketImpl(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.handleFrame(event.data, socket, { createSubscriptions, oldSocket }).catch((error) => {
        this.update({ status: "error", label: "Twitch subscription failed", error: error.message });
      });
    });
    socket.addEventListener("error", () => this.update({ status: "error", label: "Twitch connection error", error: "WebSocket error" }));
    socket.addEventListener("close", () => {
      if (!this.stopped && socket === this.socket) this.scheduleReconnect();
    });
  }

  async handleFrame(raw, socket, context) {
    let frame;
    try { frame = JSON.parse(String(raw)); }
    catch { return; }
    this.resetWatchdog(frame.payload?.session?.keepalive_timeout_seconds);
    const envelopeId = frame.metadata?.message_id;
    if (envelopeId && this.seenEnvelopeIds.has(envelopeId)) return;
    if (envelopeId) this.seenEnvelopeIds.set(envelopeId, Date.now());
    this.pruneEnvelopeIds();

    const type = frame.metadata?.message_type;
    if (type === "session_welcome") {
      if (context.oldSocket) context.oldSocket.close();
      this.reconnectAttempt = 0;
      if (context.createSubscriptions) await this.subscribe(frame.payload.session.id);
      this.update({ status: "live", label: "Live Twitch chat", error: null });
      return;
    }
    if (type === "session_reconnect") {
      const reconnectUrl = frame.payload?.session?.reconnect_url;
      if (reconnectUrl) this.connect(reconnectUrl, { createSubscriptions: false, oldSocket: socket });
      return;
    }
    if (type === "revocation") {
      this.update({ status: "revoked", label: "Twitch subscription revoked", error: frame.payload?.subscription?.status ?? "revoked" });
      return;
    }
    const message = mapTwitchChatEvent(frame);
    if (!message) return;
    const result = this.options.detector.ingest(message);
    if (result.accepted) {
      this.update({
        messagesReceived: this.state.messagesReceived + 1,
        lastEventAt: new Date().toISOString()
      });
      this.options.onMessage(message, result);
    }
  }

  async subscribe(sessionId) {
    const body = {
      type: "channel.chat.message", version: "1",
      condition: {
        broadcaster_user_id: this.options.broadcasterUserId,
        user_id: this.options.userId
      },
      transport: { method: "websocket", session_id: sessionId }
    };
    await this.requestJson(SUBSCRIPTIONS_URL, {
      method: "POST", headers: this.helixHeaders(), body: JSON.stringify(body)
    });
  }

  resetWatchdog(timeoutSeconds) {
    clearTimeout(this.watchdog);
    const seconds = Number(timeoutSeconds ?? 30);
    this.watchdog = setTimeout(() => {
      if (!this.stopped) {
        this.update({ status: "reconnecting", label: "Reconnecting Twitch", error: "Keepalive timeout" });
        this.socket?.close();
      }
    }, (seconds + 5) * 1_000);
    this.watchdog.unref?.();
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt++);
    this.update({ status: "reconnecting", label: "Reconnecting Twitch", reconnectInMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(EVENTSUB_URL, { createSubscriptions: true }), delay);
    this.reconnectTimer.unref?.();
  }

  pruneEnvelopeIds(now = Date.now()) {
    for (const [id, seenAt] of this.seenEnvelopeIds) if (now - seenAt > 120_000) this.seenEnvelopeIds.delete(id);
  }

  async requestJson(url, init) {
    const response = await this.options.fetchImpl(url, init);
    if (!response.ok) throw new Error("Twitch API " + response.status + ": " + await response.text());
    return response.json();
  }
}
