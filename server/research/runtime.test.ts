import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchSession } from "@shared/research";
import { closeSQLite, saveSession } from "./store";

const fakes = vi.hoisted(() => ({ runResearch: vi.fn(), createResearchSession: vi.fn() }));
vi.mock("./engine", () => ({ runResearch: fakes.runResearch, createResearchSession: fakes.createResearchSession }));
import { getResearchHistory, getResearchSession } from "./runtime";

const originalStorage = process.env.RESEARCH_STORAGE;
const originalPath = process.env.RESEARCH_DB_PATH;
const testDirectory = mkdtempSync(join(tmpdir(), "researchpilot-restart-test-"));
process.env.RESEARCH_STORAGE = "sqlite";
process.env.RESEARCH_DB_PATH = join(testDirectory, "sessions.sqlite");

beforeEach(() => {
  process.env.RESEARCH_STORAGE = "sqlite";
  process.env.RESEARCH_DB_PATH = join(testDirectory, "sessions.sqlite");
});

afterAll(() => {
  closeSQLite();
  if (originalStorage === undefined) delete process.env.RESEARCH_STORAGE;
  else process.env.RESEARCH_STORAGE = originalStorage;
  if (originalPath === undefined) delete process.env.RESEARCH_DB_PATH;
  else process.env.RESEARCH_DB_PATH = originalPath;
  rmSync(testDirectory, { recursive: true, force: true });
});

const staleSession: ResearchSession = {
  id: "33333333-3333-4333-8333-333333333333", goal: "Recover an interrupted research session", status: "running", createdAt: 100, updatedAt: 200,
  plan: null, events: [], sources: [], evidence: [], toolCalls: [], decisions: [], errors: [], report: "",
  verification: null,
  metrics: { startedAt: 100, llmCalls: 0, toolCalls: 0, searches: 0, sourcesAnalyzed: 0, completedSteps: 0, replans: 0, verificationStatus: "PENDING", errors: 0, finalResponseLength: 0, iterations: 0 },
};

describe("runtime restart recovery", () => {
  it("converts an orphaned persisted running session into an explicit failure event", async () => {
    await saveSession({ ...staleSession, events: [] });
    const recovered = await getResearchSession(staleSession.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.events[recovered.events.length - 1]).toMatchObject({ stage: "error", title: "Run interrupted by server restart" });
    expect(recovered?.errors[0]).toContain("server process restarted");
    expect((await getResearchSession(staleSession.id))?.events).toHaveLength(1);
  });

  it("also repairs stale sessions before returning persisted run history", async () => {
    const other = { ...staleSession, id: "44444444-4444-4444-8444-444444444444", goal: "Another interrupted run", createdAt: 300, updatedAt: 400 };
    await saveSession(other);
    const history = await getResearchHistory();
    expect(history.find(session => session.id === other.id)?.status).toBe("failed");
  });
});
