import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ invokeLLM: vi.fn(), listLLMModels: vi.fn() }));
vi.mock("../_core/llm", () => provider);
import { generateStructured } from "./llm";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const request = { promptName: "test_payload", system: "Return JSON.", user: "Test a structured response.", schema };

describe("strict structured model responses", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "manus_builtin");
    vi.stubEnv("LLM_MODEL", "gpt-5-mini");
    provider.invokeLLM.mockReset();
    provider.listLLMModels.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("retries malformed model JSON once using the same schema and request", async () => {
    provider.invokeLLM
      .mockResolvedValueOnce({ choices: [{ message: { content: "not JSON" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] });

    await expect(generateStructured<{ ok: boolean }>(request)).resolves.toEqual({ ok: true });
    expect(provider.invokeLLM).toHaveBeenCalledTimes(2);
    expect(provider.invokeLLM.mock.calls[0]?.[0]).toEqual(provider.invokeLLM.mock.calls[1]?.[0]);
  });

  it("does not expose malformed response content in the final error", async () => {
    provider.invokeLLM.mockResolvedValue({ choices: [{ message: { content: "private-injected-payload" } }] });

    await expect(generateStructured(request)).rejects.toThrow("The configured LLM returned non-JSON structured output.");
    expect(provider.invokeLLM).toHaveBeenCalledTimes(2);
  });
});
