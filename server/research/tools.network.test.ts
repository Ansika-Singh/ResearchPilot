import { afterEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
import { extractPage } from "./tools";

const publicAddress = [{ address: "93.184.216.34", family: 4 }];

describe("public URL extraction network guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    dns.lookup.mockReset();
  });

  it("bounds an unresponsive DNS lookup", async () => {
    vi.useFakeTimers();
    dns.lookup.mockImplementation(() => new Promise(() => undefined));
    const extraction = expect(extractPage("https://slow.example/path")).rejects.toThrow(/DNS lookup timed out/i);
    await vi.advanceTimersByTimeAsync(3_000);
    await extraction;
  });

  it("revalidates a redirect and refuses a private destination before fetching it", async () => {
    dns.lookup.mockResolvedValue(publicAddress);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(extractPage("https://public.example/start")).rejects.toThrow(/private|local/i);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect only after validating its host", async () => {
    dns.lookup.mockResolvedValue(publicAddress);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example/event" } }))
      .mockResolvedValueOnce(new Response("<html><title>Campus workshop</title><p>Two day event</p></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await extractPage("https://public.example/start");

    expect(page.title).toBe("Campus workshop");
    expect(page.text).toContain("Two day event");
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => call[1]?.redirect)).toEqual(["manual", "manual"]);
  });
});
