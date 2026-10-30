import { createHmac, timingSafeEqual } from "node:crypto";

const decodeJson = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export function verifyExtensionJwt(token, options = {}) {
  const value = String(token ?? "").trim();
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid Twitch Extension token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (header.alg !== "HS256") throw new Error("Unsupported Twitch Extension token algorithm");

  const secretValue = String(options.secret ?? process.env.TWITCH_EXTENSION_SECRET ?? "").trim();
  if (!secretValue) throw new Error("TWITCH_EXTENSION_SECRET is not configured");
  const secret = Buffer.from(secretValue, "base64");
  const expected = createHmac("sha256", secret).update(encodedHeader + "." + encodedPayload).digest();
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid Twitch Extension token signature");
  }

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) throw new Error("Twitch Extension token expired");
  const channelId = String(options.channelId ?? "").trim();
  if (channelId && String(payload.channel_id ?? "") !== channelId) {
    throw new Error("Twitch Extension token belongs to another channel");
  }
  if (!["viewer", "moderator", "broadcaster"].includes(payload.role)) {
    throw new Error("Unsupported Twitch Extension viewer role");
  }

  return {
    userId: payload.user_id ? String(payload.user_id) : null,
    opaqueUserId: String(payload.opaque_user_id ?? ""),
    channelId: String(payload.channel_id ?? ""),
    role: payload.role,
    linked: Boolean(payload.user_id) && payload.is_unlinked !== true
  };
}

export function createExtensionToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(header + "." + body).digest("base64url");
  return header + "." + body + "." + signature;
}
