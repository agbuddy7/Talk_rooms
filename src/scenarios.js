export const scenarios = {
  "character-choice": {
    name: "Character choice disagreement",
    messages: [
      ["maya", "Brim was the better character for this quest"],
      ["leo", "I really wanted Brim, his storyline is much stronger"],
      ["nora", "No way, choosing Nova was the right move"],
      ["sam", "Brim would have unlocked the secret ending"],
      ["ivy", "Nova is funny but Brim had the better story here"],
      ["omar", "The streamer ignored all the clues for Brim"],
      ["zoe", "I am disappointed we lost the Brim storyline"],
      ["liam", "Nova supporters won but Brim was clearly better"],
      ["maya", "That Brim ending would have been incredible"],
      ["rae", "The character choice changed the whole quest"],
      ["kai", "Brim fans deserved that secret ending"],
      ["nora", "Nova still fits this team better though"]
    ]
  },
  "emote-storm": {
    name: "Emote storm (should be filtered)",
    messages: [
      ["u1", "😂😂😂"], ["u2", "LULW LULW"], ["u3", "Pog Pog Pog"],
      ["u4", "😂"], ["u5", "OMEGALUL"], ["u6", "Kappa Kappa"],
      ["u7", "PogChamp"], ["u8", "😂😂"], ["u9", "LULW"], ["u10", "W W W"]
    ]
  },
  "guest-reactions": {
    name: "Guest dynamics",
    messages: [
      ["maya", "The guest keeps interrupting every answer"],
      ["leo", "I wish the guest would let the streamer finish speaking"],
      ["nora", "The interruptions are making this interview difficult"],
      ["sam", "The guest has interrupted the same story three times"],
      ["ivy", "I like the guest but the conversation needs more balance"],
      ["omar", "The streamer barely gets to answer before another interruption"],
      ["zoe", "This guest dynamic feels awkward today"],
      ["liam", "The interview would be better with fewer interruptions"],
      ["rae", "Please let the streamer complete the story"],
      ["kai", "The conversation balance is frustrating viewers"]
    ]
  }
};

export async function replayScenario(detector, scenario, onStep = () => {}, delayMs = 260) {
  const startedAt = Date.now();
  for (let index = 0; index < scenario.messages.length; index += 1) {
    const [user, text] = scenario.messages[index];
    const message = {
      id: `${startedAt}-${index}`,
      userId: user,
      displayName: user,
      text,
      timestamp: Date.now()
    };
    detector.ingest(message);
    onStep(message);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
