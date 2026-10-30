import { performance } from "node:perf_hooks";
import { HotTopicDetector } from "./detector.js";
import { HashingEmbedder } from "./embedders.js";

const detector = new HotTopicDetector({ embedder: new HashingEmbedder(), maxQueue: 2_000, minMessages: 4 });
const templates = ["Brim deserved the secret ending", "the guest keeps interrupting", "Nova was the better choice", "😂😂😂"];
const startedAt = performance.now();
for (let index = 0; index < 10_000; index += 1) detector.ingest({
  id: "bench-" + index, userId: "viewer-" + (index % 2_000), text: templates[index % templates.length], timestamp: Date.now()
});
const state = await detector.flush();
console.log(JSON.stringify({
  inputMessages: 10_000, elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
  queueDrops: state.pipeline.dropped, batches: state.pipeline.batches, topics: state.topics.length
}, null, 2));
