import { afterEach, describe, expect, it, vi } from "vitest";
import { calculate, calculateBatch, normalizeSearchQuery, normalizeSearchRecords, readUserFile, validatePublicUrl } from "./tools";

describe("ResearchPilot tools", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("evaluates arithmetic with correct precedence and parentheses", () => {
    expect(calculate("200*500+25000")).toBe(125000);
    expect(calculate("(18+2)*3/2")).toBe(30);
  });

  it("validates and computes a bounded batch of equation-style arithmetic", () => {
    expect(calculateBatch("200 * 500 = 100000; 100000 + 25000 = 125000; 125000 / 200 = 625")).toEqual([
      { expression: "200 * 500", result: 100000 },
      { expression: "100000 + 25000", result: 125000 },
      { expression: "125000 / 200", result: 625 },
    ]);
    expect(calculateBatch("₹200 × 500 = INR 100,000")[0]).toEqual({ expression: "200 * 500", result: 100000 });
    expect(() => calculateBatch("200*500=999; 100000/200=500")).toThrow(/does not match/i);
    expect(() => calculateBatch("process.exit()" )).toThrow();
  });

  it("rejects code, malformed input, excessive input, and division by zero", () => {
    expect(() => calculate("process.exit()" )).toThrow();
    expect(() => calculate("5/0")).toThrow(/zero/i);
    expect(() => calculate("1+" )).toThrow();
    expect(() => calculate("9".repeat(200))).toThrow();
  });

  it("blocks local and private targets before making a network request", async () => {
    await expect(validatePublicUrl("http://127.0.0.1/admin")).rejects.toThrow(/private|local/i);
    await expect(validatePublicUrl("http://localhost:3000")).rejects.toThrow(/private|local/i);
    await expect(validatePublicUrl("file:///etc/passwd")).rejects.toThrow(/HTTP/i);
  });

  it("reads bounded CSV and JSON files and refuses unsupported formats", () => {
    expect(readUserFile("attendance.csv", "name,score\nA,9\nB,10").summary).toContain("2 data rows");
    expect(readUserFile("data.json", "{\"ok\":true}").summary).toContain("Valid JSON");
    expect(() => readUserFile("script.js", "alert(1)")).toThrow(/Supported file types/i);
    expect(() => readUserFile("too-large.txt", "x".repeat(80_001))).toThrow(/80,000/i);
  });

  it("normalizes only valid unique http(s) search sources", () => {
    const sources = normalizeSearchRecords([
      { title: "Good", url: "https://example.org/a", domain: "example.org", snippet: "evidence" },
      { title: "Duplicate", url: "https://example.org/a", domain: "example.org", snippet: "duplicate" },
      { title: "Invalid", url: "javascript:alert(1)", domain: "", snippet: "not a source" },
    ], 100);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: "S1", url: "https://example.org/a", retrievedAt: 100 });
  });

  it("turns multi-search instructions into one bounded actionable query", () => {
    const query = normalizeSearchQuery(`Run several focused searches. Suggested queries (run each until results):\n\n1) site:edu.in OR site:ac.in \"AI workshop\" \"students\" \"in-person\"\n2) site:edu.in \"machine learning workshop\"`);
    expect(query).toContain("AI workshop");
    expect(query).toMatch(/site:edu\.in/);
    expect(query).toContain("OR");
    expect(query).not.toMatch(/\n|\b2\)/);
    expect(query.length).toBeLessThanOrEqual(180);
  });

  it("simplifies restricted DuckDuckGo queries before declaring search unavailable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html><body>no result anchors</body></html>", { status: 200 }))
      .mockResolvedValueOnce(new Response('<a class="result__a" href="https://example.org/workshop">Indian College Workshop</a><div class="result__snippet">An in-person university event.</div>', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await (await import("./tools")).webSearch('site:example.org "in-person" workshop OR college', 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0] as URL).searchParams.get("q")).not.toContain("site:");
    expect(results[0]).toMatchObject({ title: "Indian College Workshop", url: "https://example.org/workshop", domain: "example.org" });
  });
});
