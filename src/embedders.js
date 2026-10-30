import { normalizeText, tokensFor } from "./text.js";

const ALIASES = new Map(Object.entries({
  annoyed: ["annoying", "irritating", "frustrating", "awkward"],
  interrupt: ["interrupting", "interrupted", "interruptions", "finish", "speaking", "answer"],
  choose: ["choosing", "choice", "selected", "pick", "picked"],
  disappointed: ["disappointed", "lost", "deserved", "wanted"],
  story: ["storyline", "ending", "quest", "clues"],
  guest: ["guest", "interview", "conversation"],
  balance: ["balance", "barely", "fewer", "complete"]
}));

function featuresFor(text) {
  const normalized = normalizeText(text);
  const words = tokensFor(normalized);
  const features = new Set(words);
  for (const [root, aliases] of ALIASES) if (aliases.some((alias) => normalized.includes(alias))) features.add(root);
  for (const word of words) {
    const padded = "^" + word + "$";
    for (let index = 0; index < padded.length - 2; index += 1) features.add("c:" + padded.slice(index, index + 3));
  }
  return features;
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export class HashingEmbedder {
  constructor(dimensions = 384) { this.dimensions = dimensions; this.name = "hashing-fallback"; }
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Float32Array(this.dimensions);
      for (const feature of featuresFor(text)) {
        const value = hash(feature);
        vector[value % this.dimensions] += (value & 1) === 0 ? 1 : -1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
      return vector;
    });
  }
}

export class TransformersEmbedder {
  constructor(options = {}) {
    this.model = options.model ?? "onnx-community/all-MiniLM-L6-v2-ONNX";
    this.fallback = options.fallback ?? new HashingEmbedder();
    this.name = this.model; this.extractorPromise = null; this.failed = false;
  }
  async extractor() {
    if (!this.extractorPromise) this.extractorPromise = import("@huggingface/transformers").then(({ pipeline }) => pipeline("feature-extraction", this.model));
    return this.extractorPromise;
  }
  async embed(texts) {
    if (this.failed) return this.fallback.embed(texts);
    try {
      const output = await (await this.extractor())(texts, { pooling: "mean", normalize: true });
      return output.tolist().map((values) => Float32Array.from(values));
    } catch (error) {
      this.failed = true;
      console.warn("Local transformer unavailable; using hashing fallback: " + error.message);
      return this.fallback.embed(texts);
    }
  }
}

export function createDefaultEmbedder() {
  return process.env.EMBEDDER === "hash" ? new HashingEmbedder() : new TransformersEmbedder({ model: process.env.LOCAL_EMBEDDING_MODEL });
}
