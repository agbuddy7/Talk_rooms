const schema = {
  type: "object", additionalProperties: false, required: ["topics"],
  properties: { topics: { type: "array", items: {
    type: "object", additionalProperties: false,
    required: ["id", "version", "title", "summary", "roomRecommended", "roomTitle", "reason", "viewpoints", "supportingMessageIds"],
    properties: {
      id: { type: "string" }, version: { type: "integer" }, title: { type: "string" },
      summary: { type: "string" },
      roomRecommended: { type: "boolean" },
      roomTitle: { type: "string" },
      reason: { type: "string" },
      viewpoints: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["label", "supportingMessageIds"],
        properties: {
          label: { type: "string" },
          supportingMessageIds: { type: "array", items: { type: "string" } }
        }
      } },
      supportingMessageIds: { type: "array", items: { type: "string" } }
    }
  } } }
};

const instructions = [
  "Judge candidate Twitch chat bursts for lightweight temporary viewer rooms.",
  "Twitch entertainment chat is often short: approve a burst when distinct viewers are clearly reacting to the same specific stream moment, game decision, person, outcome, joke, frustration, or opinion, even if the messages are brief or informal.",
  "Do not require a formal debate or long explanations. A coherent shared reaction is enough when the subject is identifiable.",
  "Reject only emote-like or catchphrase spam with no identifiable subject, unrelated messages accidentally clustered together, targeted harassment, or clusters with no shared moment or opinion.",
  "Set roomRecommended false for rejected candidates and explain briefly.",
  "For approved candidates, create a catchy 3–6 word roomTitle, a precise topic title, a one-sentence summary, and one or two evidence-based viewpoints. For a shared reaction, use one viewpoint with all relevant evidence. Give each viewpoint at least two supporting message IDs when possible.",
  "Use only supplied message IDs. Keep rejected candidates in the output so the application receives the veto."
].join(" ");

export function resolveLlmConfiguration(options = {}) {
  const provider = String(options.provider ?? process.env.LLM_PROVIDER ?? (process.env.GROQ_API_KEY ? "groq" : "openai")).toLowerCase();
  if (provider === "groq") {
    return {
      provider,
      apiKey: options.apiKey ?? process.env.GROQ_API_KEY,
      model: options.model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
      endpoint: options.endpoint ?? "https://api.groq.com/openai/v1/responses",
      reasoningEffort: options.reasoningEffort ?? process.env.GROQ_REASONING_EFFORT ?? "low"
    };
  }
  return {
    provider: "openai",
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-astra",
    endpoint: options.endpoint ?? "https://api.openai.com/v1/responses",
    reasoningEffort: options.reasoningEffort
  };
}

export async function analyzeWithLlm(snapshot, options = {}) {
  const config = resolveLlmConfiguration(options);
  if (!config.apiKey) throw new Error(config.provider.toUpperCase() + "_API_KEY is not configured");
  const format = { type: "json_schema", name: "sidechat_topics", schema };
  if (config.provider === "openai") format.strict = true;
  const body = {
    model: config.model,
    instructions,
    input: JSON.stringify({ topics: snapshot }),
    max_output_tokens: Number(options.maxOutputTokens ?? process.env.LLM_MAX_OUTPUT_TOKENS ?? 600),
    text: { format }
  };
  if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = new Error(config.provider + " response " + response.status + ": " + await response.text());
    error.status = response.status;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : null;
    throw error;
  }
  const data = await response.json();
  if (data.status && data.status !== "completed") throw new Error(config.provider + " response did not complete: " + data.status);
  const outputText = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error(config.provider + " response contained no structured output");
  return JSON.parse(outputText);
}
