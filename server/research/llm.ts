import { invokeLLM, listLLMModels } from "../_core/llm";
import { ENV } from "../_core/env";

export type JsonSchema = Record<string, unknown>;
type Message = { role: "system" | "user"; content: string };
type Completion = { choices: Array<{ message?: { content?: string | null } }> };
type StructuredRequest = { model: string; messages: Message[]; schema: JsonSchema; name: string };

export interface LLMProvider {
  readonly name: string;
  resolveModel(): Promise<string>;
  completeStructured(input: StructuredRequest): Promise<string>;
}

let cachedModel: string | null = null;
let modelListPromise: Promise<string> | null = null;

const builtinProvider: LLMProvider = {
  name: "manus_builtin",
  async resolveModel() {
    if (process.env.LLM_MODEL?.trim()) return process.env.LLM_MODEL.trim();
    if (cachedModel) return cachedModel;
    if (!ENV.forgeApiKey && !process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
      throw new Error("No LLM API key configured. Please set OPENAI_API_KEY (or LLM_API_KEY) in your .env file.");
    }
    if (!modelListPromise) {
      modelListPromise = (async () => {
        const catalog = await listLLMModels();
        const models = Array.isArray(catalog.data) ? catalog.data : [];
        const chosen = models.find(model => model.id === "gpt-5-mini") ?? models.find(model => model.id === "gpt-5-nano") ?? models[0];
        if (!chosen?.id) throw new Error("No supported model is available from the configured built-in LLM provider.");
        cachedModel = chosen.id;
        return cachedModel;
      })().finally(() => { modelListPromise = null; });
    }
    return modelListPromise;
  },
  async completeStructured(input) {
    const response = await invokeLLM({
      model: input.model,
      messages: input.messages,
      response_format: { type: "json_schema", json_schema: { name: input.name, strict: true, schema: input.schema } },
    });
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("The built-in LLM returned no structured output.");
    return content;
  },
};

const compatibleProvider: LLMProvider = {
  name: "openai_compatible",
  async resolveModel() {
    const model = process.env.LLM_MODEL?.trim() || "gpt-4o-mini";
    return model;
  },
  async completeStructured(input) {
    const base = (process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY)?.trim();
    if (!apiKey) {
      throw new Error("No LLM API key configured. Please set LLM_API_KEY in your .env file.");
    }
    const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    let maxTokens = 1200;
    if (input.name.includes("action") || input.name.includes("decision")) maxTokens = 350;
    else if (input.name.includes("plan")) maxTokens = 850;
    else if (input.name.includes("observation")) maxTokens = 850;
    else if (input.name.includes("verification")) maxTokens = 600;
    else if (input.name.includes("report") || input.name.includes("synthesis")) maxTokens = 2200;

    const tokenLimit = input.model.startsWith("gpt-5") || input.model.startsWith("o1") || input.model.startsWith("o3")
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };

    let activeModel = input.model;
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: activeModel,
            messages: input.messages,
            response_format: { type: "json_schema", json_schema: { name: input.name, strict: false, schema: input.schema } },
            ...tokenLimit,
          }),
          signal: AbortSignal.timeout(25_000),
        });

        if (response.ok) {
          const payload = await response.json() as Completion;
          const content = payload.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error("The compatible LLM returned no structured output.");
          return content;
        }

        const errBody = await response.text().catch(() => "");
        if (response.status === 429 && attempt < maxRetries) {
          if (activeModel.includes("120b")) {
            console.warn(`[LLM] Model ${activeModel} hit quota/rate limit. Switching to openai/gpt-oss-20b...`);
            activeModel = "openai/gpt-oss-20b";
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          if (activeModel.includes("20b") && attempt === 0) {
            console.warn(`[LLM] Model ${activeModel} hit rate limit. Switching to alternate Groq model qwen/qwen3.8-27b...`);
            activeModel = "qwen/qwen3.8-27b";
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          if (activeModel.includes("qwen") && attempt === 0) {
            console.warn(`[LLM] Model ${activeModel} hit rate limit. Switching to alternate Groq model openai/gpt-oss-20b...`);
            activeModel = "openai/gpt-oss-20b";
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          const retryHeader = response.headers.get("retry-after");
          let delayMs = 2000;
          if (retryHeader && Number.isFinite(Number(retryHeader))) {
            delayMs = Math.max(1, Number(retryHeader)) * 1000;
          } else {
            const match = errBody.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
            if (match) {
              const minutes = match[1] ? parseFloat(match[1]) : 0;
              const seconds = match[2] ? parseFloat(match[2]) : 0;
              delayMs = Math.ceil((minutes * 60 + seconds) * 1000) + 300;
            }
          }
          const cappedDelay = Math.min(delayMs, 4_000);
          console.warn(`[LLM] Rate limit reached. Backing off for ${cappedDelay}ms before retry (${attempt + 1}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, cappedDelay));
          continue;
        }

        if (response.status >= 500 && attempt < maxRetries) {
          const delayMs = 1500 * (attempt + 1);
          console.warn(`[LLM] Server returned ${response.status}. Retrying in ${delayMs}ms (${attempt + 1}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }

        if (response.status === 400 && errBody.includes("tool_use_failed")) {
          try {
            const parsed = JSON.parse(errBody);
            const failedGen = parsed.error?.failed_generation;
            if (typeof failedGen === "string") {
              const toolCall = JSON.parse(failedGen);
              if (toolCall.name === "web_search" || toolCall.name === "search") {
                const query = toolCall.arguments?.query || toolCall.arguments?.q || "";
                console.log(`[LLM] Recovered tool call from failed_generation: search -> ${query}`);
                return JSON.stringify({
                  action: "search",
                  reason: "Execute search for relevant query",
                  expectedResult: "Relevant search results",
                  stepId: null,
                  query: query || null,
                  url: null,
                  expression: null,
                  replanFocus: null,
                });
              }
              if (toolCall.name === "extract" || toolCall.name === "url_extractor") {
                const url = toolCall.arguments?.url || "";
                console.log(`[LLM] Recovered tool call from failed_generation: extract -> ${url}`);
                return JSON.stringify({
                  action: "extract",
                  reason: "Extract page content",
                  expectedResult: "Extracted source text",
                  stepId: null,
                  query: null,
                  url: url || null,
                  expression: null,
                  replanFocus: null,
                });
              }
            }
          } catch {
            // fallback
          }
        }

        throw new Error(`Configured LLM returned HTTP ${response.status}: ${errBody || response.statusText}. Check provider configuration, model access, and structured-output support.`);
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("HTTP")) throw err;
        console.warn(`[LLM] Request failed (${msg}). Retrying in 2000ms...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    throw new Error("LLM request failed after exhausting all retry attempts.");
  },
};

export function getLLMProvider(): LLMProvider {
  const requested = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const hasLocalKey = !!(process.env.LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());

  if (requested === "openai_compatible" || requested === "compatible") {
    return compatibleProvider;
  }
  if (requested === "manus_builtin" || requested === "builtin" || requested === "manus") {
    // If running outside the platform environment but a local API key is provided, gracefully use compatibleProvider
    if (!ENV.forgeApiKey && hasLocalKey) {
      return compatibleProvider;
    }
    return builtinProvider;
  }
  if (hasLocalKey) {
    return compatibleProvider;
  }
  if (ENV.forgeApiKey) {
    return builtinProvider;
  }
  return compatibleProvider;
}

export async function getResearchModel(): Promise<string> {
  return getLLMProvider().resolveModel();
}

function parseStructuredContent<T>(content: string): T {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(trimmed) as T; } catch { /* Find one balanced JSON object if a provider adds leading/trailing prose. */ }
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, index + 1)) as T; } catch { break; }
      }
    }
  }
  throw new Error("The configured LLM returned non-JSON structured output.");
}

export async function generateStructured<T>(input: {
  promptName: string;
  system: string;
  user: string;
  schema: JsonSchema;
}): Promise<T> {
  const provider = getLLMProvider();
  const model = await provider.resolveModel();
  const request: StructuredRequest = {
    model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    schema: input.schema,
    name: input.promptName.replace(/[^a-z0-9_]/gi, "_").slice(0, 60),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await provider.completeStructured(request);
    try {
      return parseStructuredContent<T>(content);
    } catch (error) {
      if (attempt === 1) throw error;
      console.warn("The LLM returned malformed structured JSON; retrying once with the same strict schema.");
    }
  }
  throw new Error("The configured LLM returned non-JSON structured output.");
}
