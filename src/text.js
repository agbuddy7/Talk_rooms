const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "been", "but", "by",
  "do", "does", "for", "from", "had", "has", "have", "he", "her", "him", "his",
  "i", "if", "in", "is", "it", "its", "just", "me", "my", "of", "on", "or",
  "our", "she", "so", "that", "the", "their", "them", "they", "this", "to", "too",
  "was", "we", "were", "what", "when", "who", "why", "with", "would", "you", "your"
]);

const EMOTE_WORDS = new Set([
  "kappa", "lul", "lulw", "pog", "pogchamp", "omegalul", "pepehands", "heyguys",
  "copium", "kekw", "sadge", "monkas", "clap", "w", "l"
]);

const POSITIVE = new Set([
  "amazing", "awesome", "best", "brilliant", "cool", "excited", "fun", "funny",
  "good", "great", "happy", "hype", "incredible", "love", "perfect", "win"
]);

const NEGATIVE = new Set([
  "angry", "annoyed", "annoying", "awful", "bad", "disappointed", "frustrated",
  "hate", "irritating", "mad", "ruined", "sad", "terrible", "upset", "worse", "worst"
]);

export function normalizeText(text = "") {
  return text.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(.)\1{4,}/g, "$1$1$1")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

export function tokensFor(text) {
  return normalizeText(text).split(" ").filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !EMOTE_WORDS.has(token));
}

export function isEmojiOnly(text, fragments = []) {
  if (fragments.length > 0) {
    const meaningful = fragments.filter((fragment) => fragment.type !== "emote");
    if (meaningful.length === 0) return true;
    if (meaningful.every((fragment) => normalizeText(fragment.text).length === 0)) return true;
  }
  const words = normalizeText(text).split(" ").filter(Boolean);
  if (words.length > 0 && words.every((word) => EMOTE_WORDS.has(word))) return true;
  return words.length === 0 && text.trim().length > 0;
}

export function sentimentFor(tokens) {
  let positive = 0;
  let negative = 0;
  for (const token of tokens) {
    if (POSITIVE.has(token)) positive += 1;
    if (NEGATIVE.has(token)) negative += 1;
  }
  if (positive === negative) return "neutral";
  return positive > negative ? "positive" : "negative";
}

export function similarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, containment * 0.72);
}

const TITLE_NOISE = new Set([
  "chat", "bro", "bruh", "like", "look", "get", "got", "one", "only", "really",
  "another", "current", "time", "today", "tonight", "streamer", "viewer", "viewers"
]);

export function titleFromTokens(tokenCounts, sentiment = "neutral", ignoredTokens = new Set()) {
  const ranked = [...tokenCounts.entries()]
    .filter(([token]) => token.length >= 3 && !TITLE_NOISE.has(token) && !ignoredTokens.has(token))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const repeated = ranked.filter(([, count]) => count >= 2);
  const tokens = (repeated.length ? repeated : ranked).slice(0, 2).map(([token]) => token);
  const subject = tokens.map((token) => token[0].toUpperCase() + token.slice(1)).join(" ");
  if (!subject) return "Chat found a new moment";
  if (sentiment === "negative") return subject + ": chat is not happy";
  if (sentiment === "positive") return subject + " hype";
  return subject + ": chat reacts";
}
