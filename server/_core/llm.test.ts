import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ forgeApiUrl: "https://llm.example.invalid", forgeApiKey: "test-only" }));
vi.mock("./env", () => ({ ENV: env }));
import { invokeLLM } from "./llm";

describe("built-in LLM request timeout recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a timed-out call once with a fresh AbortSignal", async () => {
    const response = { id: "test", created: 1, model: "gpt-5-mini", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeLLM({ model: "gpt-5-mini", messages: [{ role: "user", content: "test" }] });

    expect(result.choices[0]?.message.content).toBe("{}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    const retrySignal = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(firstSignal).toBeDefined();
    expect(retrySignal).toBeDefined();
    expect(retrySignal).not.toBe(firstSignal);
  });

  it("fails after two timed-out attempts with a bounded, readable error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(invokeLLM({ model: "gpt-5-mini", messages: [{ role: "user", content: "test" }] })).rejects.toThrow("timed out after two bounded 45-second attempts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
