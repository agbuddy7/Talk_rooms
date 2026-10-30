import { createDefaultEmbedder } from "./embedders.js";
import { isEmojiOnly, normalizeText, sentimentFor, titleFromTokens, tokensFor } from "./text.js";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const cosine = (left, right) => {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
};
const ANCHOR_STOP = new Set([
  "better", "character", "quest", "story", "storyline", "stronger", "secret", "ending",
  "streamer", "answer", "conversation", "balance", "viewers", "interview", "interruptions",
  "wanted", "deserved", "choice", "whole", "right", "move", "funny", "supporters"
]);
const anchorsFor = (tokens, ignored) => new Set(tokens.filter((token) => token.length >= 4 && !ANCHOR_STOP.has(token) && !ignored.has(token)));
const anchorsForCluster = (cluster, ignored) => {
  const minimumEvidence = Math.max(1, Math.ceil(cluster.messages.length * 0.3));
  return new Set([...cluster.tokenCounts.entries()]
    .filter(([token, count]) => count >= minimumEvidence && token.length >= 4 && !ANCHOR_STOP.has(token) && !ignored.has(token))
    .map(([token]) => token));
};

export class HotTopicDetector {
  constructor(options = {}) {
    this.embedder = options.embedder ?? createDefaultEmbedder();
    const usingHashFallback = this.embedder.name === "hashing-fallback";
    const defaultSimilarityThreshold = usingHashFallback ? 0.22 : 0.42;
    this.options = {
      windowMs: 45_000, topicTtlMs: 60_000, confirmationWindowMs: 600,
      minUniqueViewers: usingHashFallback ? 3 : 4,
      minMessages: usingHashFallback ? 3 : 4,
      similarityThreshold: defaultSimilarityThreshold,
      hotThreshold: 0.42, maxQueue: 2_000, batchSize: 32, maxTopics: 8, ...options
    };
    this.options.ignoredAnchors = new Set((options.ignoredAnchors ?? []).map((value) => normalizeText(value)).filter(Boolean));
    this.messages = []; this.pending = []; this.clusters = new Map(); this.seenEventIds = new Map();
    this.analysisRequests = new Map();
    this.nextClusterId = 1;
    this.metrics = { dropped: 0, embedded: 0, batches: 0, lastBatchMs: 0, embedding: this.embedder.name };
    this.lastState = this.emptyState();
  }

  emptyState() {
    return {
      generatedAt: new Date().toISOString(),
      totals: { received: 0, substantive: 0, filtered: 0, uniqueViewers: 0 },
      pipeline: { queued: 0, ...this.metrics }, topics: [], recentMessages: []
    };
  }

  reset() {
    this.messages = []; this.pending = []; this.clusters.clear(); this.seenEventIds.clear(); this.nextClusterId = 1;
    this.analysisRequests.clear();
    this.metrics = { dropped: 0, embedded: 0, batches: 0, lastBatchMs: 0, embedding: this.embedder.name };
    this.lastState = this.emptyState();
  }

  ingest(input) {
    const now = Date.now();
    const id = String(input.id ?? input.messageId ?? now + "-" + Math.random());
    if (this.seenEventIds.has(id)) return { accepted: false, reason: "duplicate-event" };
    const text = String(input.text ?? input.message?.text ?? "").trim();
    const fragments = input.fragments ?? input.message?.fragments ?? [];
    const normalized = normalizeText(text);
    const tokens = tokensFor(text);
    const timestamp = Number(new Date(input.timestamp ?? now));
    const filterReason = this.filterReason({ text, fragments, normalized, tokens });
    const message = {
      id, userId: String(input.userId ?? input.chatter_user_id ?? input.user ?? "anonymous"),
      displayName: String(input.displayName ?? input.chatter_user_name ?? input.user ?? "anonymous"),
      text, normalized, tokens, sentiment: sentimentFor(tokens),
      timestamp: Number.isFinite(timestamp) ? timestamp : now, filterReason, clusterId: null
    };
    this.messages.push(message); this.seenEventIds.set(id, now);
    if (!filterReason) {
      if (this.pending.length >= this.options.maxQueue) { this.pending.shift(); this.metrics.dropped += 1; }
      this.pending.push(message);
    }
    this.prune(now);
    return { accepted: true, substantive: !filterReason, filterReason };
  }

  filterReason({ text, fragments, normalized, tokens }) {
    if (!text) return "empty";
    if (/[\u0000-\u001f]/.test(text)) return "control-message";
    if (text.startsWith("!")) return "command";
    if (isEmojiOnly(text, fragments)) return "emote-only";
    if (normalized.length < 4 || tokens.length < 1) return "too-short";
    return null;
  }

  async flush(now = Date.now()) {
    while (this.pending.length) {
      const batch = this.pending.splice(0, this.options.batchSize);
      const startedAt = performance.now();
      const vectors = await this.embedder.embed(batch.map((message) => {
        const meaningful = message.tokens.filter((token) => !this.options.ignoredAnchors.has(token)).join(" ");
        return meaningful || message.text;
      }));
      batch.forEach((message, index) => this.assign(message, vectors[index]));
      this.metrics.embedded += batch.length; this.metrics.batches += 1;
      this.metrics.lastBatchMs = Number((performance.now() - startedAt).toFixed(1));
    }
    this.prune(now);
    return this.analyze(now);
  }

  assign(message, vector) {
    message.embedding = vector;
    let best = null; let bestScore = -1;
    const messageAnchors = anchorsFor(message.tokens, this.options.ignoredAnchors);
    const anchoredCandidates = [];
    for (const cluster of this.clusters.values()) {
      if (message.timestamp - cluster.lastMessageAt > this.options.topicTtlMs) continue;
      const score = cosine(vector, cluster.centroid);
      const clusterAnchors = anchorsForCluster(cluster, this.options.ignoredAnchors);
      const sharesAnchor = [...messageAnchors].some((anchor) => clusterAnchors.has(anchor));
      if (sharesAnchor) anchoredCandidates.push({ cluster, score });
      const requiredSimilarity = cluster.messages.length >= 3 && clusterAnchors.size && !sharesAnchor
        ? Math.max(0.35, this.options.similarityThreshold)
        : this.options.similarityThreshold;
      if (score >= requiredSimilarity && score > bestScore) { best = cluster; bestScore = score; }
    }
    if (anchoredCandidates.length) {
      anchoredCandidates.sort((a, b) => b.score - a.score);
      best = anchoredCandidates[0].cluster;
      bestScore = Math.max(this.options.similarityThreshold, anchoredCandidates[0].score);
    }
    if (!best || bestScore < this.options.similarityThreshold) {
      best = this.newCluster(message, vector); this.clusters.set(best.id, best);
    } else this.addToCluster(best, message, vector, bestScore);
    message.clusterId = best.id;
  }

  newCluster(message, vector) {
    return {
      id: "topic-" + this.nextClusterId++, centroid: Float32Array.from(vector), messages: [message],
      tokenCounts: new Map([...new Set(message.tokens)].map((token) => [token, 1])),
      similarities: [1], firstMessageAt: message.timestamp, lastMessageAt: message.timestamp,
      evidenceBuckets: new Set([Math.floor(message.timestamp / this.options.confirmationWindowMs)]),
      version: 1, analysis: null
    };
  }

  addToCluster(cluster, message, vector, similarityScore) {
    const count = cluster.messages.length;
    for (let index = 0; index < cluster.centroid.length; index += 1) cluster.centroid[index] = (cluster.centroid[index] * count + vector[index]) / (count + 1);
    const norm = Math.sqrt(cluster.centroid.reduce((sum, value) => sum + value * value, 0)) || 1;
    for (let index = 0; index < cluster.centroid.length; index += 1) cluster.centroid[index] /= norm;
    cluster.messages.push(message); cluster.similarities.push(similarityScore);
    cluster.lastMessageAt = Math.max(cluster.lastMessageAt, message.timestamp);
    cluster.evidenceBuckets.add(Math.floor(message.timestamp / this.options.confirmationWindowMs)); cluster.version += 1;
    for (const token of new Set(message.tokens)) cluster.tokenCounts.set(token, (cluster.tokenCounts.get(token) ?? 0) + 1);
  }

  prune(now = Date.now()) {
    const oldest = now - Math.max(this.options.windowMs, this.options.topicTtlMs);
    this.messages = this.messages.filter((message) => message.timestamp >= oldest);
    for (const [id, timestamp] of this.seenEventIds) if (timestamp < oldest) this.seenEventIds.delete(id);
    for (const [id, cluster] of this.clusters) if (now - cluster.lastMessageAt > this.options.topicTtlMs) this.clusters.delete(id);
  }

  analyze(now = Date.now()) {
    this.prune(now);
    const recent = this.messages.filter((message) => message.timestamp >= now - this.options.windowMs);
    const substantive = recent.filter((message) => !message.filterReason && message.clusterId);
    const topics = [...this.clusters.values()].map((cluster) => this.scoreCluster(cluster, now))
      .filter((topic) => topic.uniqueViewers >= this.options.minUniqueViewers && topic.messageCount >= this.options.minMessages)
      .sort((a, b) => b.score - a.score).slice(0, this.options.maxTopics);
    this.lastState = {
      generatedAt: new Date(now).toISOString(),
      totals: { received: recent.length, substantive: substantive.length, filtered: recent.length - substantive.length, uniqueViewers: new Set(recent.map((message) => message.userId)).size },
      pipeline: { ...this.metrics, queued: this.pending.length }, topics,
      recentMessages: recent.slice(-30).reverse().map(({ tokens, normalized, embedding, ...message }) => message)
    };
    return this.lastState;
  }

  scoreCluster(cluster, now) {
    const messages = cluster.messages.filter((message) => message.timestamp >= now - this.options.windowMs);
    const users = new Set(messages.map((message) => message.userId));
    const texts = new Set(messages.map((message) => message.normalized));
    const messageCount = messages.length;
    const durationSeconds = Math.max(1, (cluster.lastMessageAt - cluster.firstMessageAt) / 1000);
    const coherence = cluster.similarities.reduce((sum, value) => sum + value, 0) / cluster.similarities.length;
    const novelty = texts.size / Math.max(1, messageCount);
    const domination = 1 - users.size / Math.max(1, messageCount);
    const duplicatePenalty = clamp((1 - novelty) * 0.5 + Math.max(0, domination - 0.45));
    const score = clamp(clamp(users.size / 8) * .32 + coherence * .25 + clamp(messageCount / Math.max(8, durationSeconds * 1.5)) * .2 + clamp(durationSeconds / 12) * .13 + novelty * .1 - duplicatePenalty * .35);
    const sentiments = { positive: 0, negative: 0, neutral: 0 };
    messages.forEach((message) => { sentiments[message.sentiment] += 1; });
    const meaningfulTokenCounts = messages.map((message) =>
      message.tokens.filter((token) => !this.options.ignoredAnchors.has(token)).length
    );
    const averageTokens = meaningfulTokenCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, meaningfulTokenCounts.length);
    const detailedMessageRatio = meaningfulTokenCounts.filter((count) => count >= 3).length / Math.max(1, meaningfulTokenCounts.length);
    const sentiment = Object.entries(sentiments).sort((a, b) => b[1] - a[1])[0][0];
    const keywords = [...cluster.tokenCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([token]) => token);
    const evidenceSpanMs = cluster.lastMessageAt - cluster.firstMessageAt;
    const status = now - cluster.lastMessageAt > 15_000 ? "cooling" : evidenceSpanMs >= this.options.confirmationWindowMs && score >= this.options.hotThreshold ? "hot" : "forming";
    return {
      id: cluster.id, version: cluster.version, title: cluster.analysis?.title ?? titleFromTokens(cluster.tokenCounts, sentiment, this.options.ignoredAnchors),
      summary: cluster.analysis?.summary ?? null, viewpoints: cluster.analysis?.viewpoints ?? [],
      keywords, sentiment, score: Number(score.toFixed(3)), coherence: Number(coherence.toFixed(3)),
      uniqueViewers: users.size, messageCount, duplicatePenalty: Number(duplicatePenalty.toFixed(3)),
      averageTokens: Number(averageTokens.toFixed(2)), detailedMessageRatio: Number(detailedMessageRatio.toFixed(3)),
      ageSeconds: Number(((now - cluster.firstMessageAt) / 1000).toFixed(1)), freshWindows: cluster.evidenceBuckets.size,
      evidenceSpanMs, status,
      llmReviewed: Boolean(cluster.analysis),
      roomRecommended: cluster.analysis?.roomRecommended ?? null,
      llmReason: cluster.analysis?.reason ?? null,
      sampleMessages: messages.slice(-6).map((message) => ({ id: message.id, user: message.displayName, text: message.text }))
    };
  }

  candidateSnapshot(now = Date.now(), options = {}) {
    const limits = {
      maxCandidates: 3, maxMessages: 6, maxMessageCharacters: 240,
      minUniqueViewers: 0, minMessages: 0, minScore: 0, minCoherence: 0,
      maxDuplicatePenalty: 1, minAverageTokens: 0, minDetailedMessageRatio: 0,
      minVersionDelta: 0, ...options
    };
    const candidates = this.analyze(now).topics.filter((topic) => {
      const cluster = this.clusters.get(topic.id);
      const analyzedVersion = cluster?.analysis?.sourceVersion ?? 0;
      return topic.status === "hot" &&
        topic.uniqueViewers >= limits.minUniqueViewers && topic.messageCount >= limits.minMessages &&
        topic.score >= limits.minScore && topic.coherence >= limits.minCoherence &&
        topic.duplicatePenalty <= limits.maxDuplicatePenalty &&
        topic.averageTokens >= limits.minAverageTokens &&
        topic.detailedMessageRatio >= limits.minDetailedMessageRatio &&
        (!cluster?.analysis || topic.version - analyzedVersion >= limits.minVersionDelta);
    }).slice(0, limits.maxCandidates);
    for (const topic of candidates) this.analysisRequests.set(topic.id + ":" + topic.version, now);
    return candidates.map((topic) => ({
      id: topic.id, version: topic.version, score: topic.score,
      uniqueViewers: topic.uniqueViewers, messageCount: topic.messageCount,
      messages: topic.sampleMessages.slice(-limits.maxMessages).map((message) => ({
        ...message, text: message.text.slice(0, limits.maxMessageCharacters)
      }))
    }));
  }

  applyAnalysis(result) {
    for (const topic of result.topics ?? []) {
      const cluster = this.clusters.get(topic.id);
      const requestKey = topic.id + ":" + topic.version;
      if (!cluster || !this.analysisRequests.has(requestKey) || cluster.version < topic.version || cluster.version - topic.version > 50) continue;
      const validIds = new Set(cluster.messages.map((message) => message.id));
      if (!(topic.supportingMessageIds ?? []).every((id) => validIds.has(id))) continue;
      const viewpointIds = (topic.viewpoints ?? []).flatMap((viewpoint) => viewpoint.supportingMessageIds ?? []);
      if (!viewpointIds.every((id) => validIds.has(id))) continue;
      const localTitle = titleFromTokens(cluster.tokenCounts, "neutral", this.options.ignoredAnchors);
      cluster.analysis = {
        sourceVersion: topic.version,
        title: String(topic.title ?? "").trim() || localTitle,
        summary: String(topic.summary ?? "").trim() || null,
        viewpoints: topic.viewpoints ?? [],
        roomRecommended: topic.roomRecommended ?? true,
        roomTitle: String(topic.roomTitle ?? "").trim() || null,
        reason: String(topic.reason ?? "").trim() || null
      };
      this.analysisRequests.delete(requestKey);
    }
  }
}
