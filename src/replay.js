import { HotTopicDetector } from "./detector.js";
import { replayScenario, scenarios } from "./scenarios.js";

const id = process.argv[2] ?? "character-choice";
const scenario = scenarios[id];
if (!scenario) {
  console.error(`Unknown scenario: ${id}`);
  process.exitCode = 1;
} else {
  const detector = new HotTopicDetector({ minUniqueViewers: 3, minMessages: 4, hotThreshold: 0.45 });
  await replayScenario(detector, scenario, () => {}, 0);
  detector.analyze();
  const state = detector.analyze(Date.now() + 2_100);
  console.log(JSON.stringify(state, null, 2));
}
