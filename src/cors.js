const twitchExtensionOrigin = /^https:\/\/[a-z0-9-]+\.ext-twitch\.tv$/i;
const localDevelopmentOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

export function parseAllowedOrigins(value = "") {
  return String(value).split(",").map((origin) => origin.trim()).filter(Boolean);
}

export function isAllowedCorsOrigin(origin, configuredOrigins = []) {
  if (!origin) return false;
  if (configuredOrigins.length) return configuredOrigins.includes(origin);
  return twitchExtensionOrigin.test(origin) || localDevelopmentOrigin.test(origin);
}

