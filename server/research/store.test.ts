import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchSession } from "@shared/research";
import { closeSQLite, listSessions, loadSession, saveSession } from "./store";

const originalStorage = process.env.RESEARCH_STORAGE;
const originalPath = process.env.RESEARCH_DB_PATH;
const testDirectory = mkdtempSync(join(tmpdir(), "researchpilot-test-"));
process.env.RESEARCH_STORAGE = "sqlite";
process.env.RESEARCH_DB_PATH = join(testDirectory, "sessions.sqlite");

afterEach(() => {
  closeSQLite();
  if (originalStorage === undefined) delete process.env.RESEARCH_STORAGE;
  else process.env.RESEARCH_STORAGE = originalStorage;
  if (originalPath === undefined) delete process.env.RESEARCH_DB_PATH;
  else process.env.RESEARCH_DB_PATH = originalPath;
  rmSync(testDirectory, { recursive: true, force: true });
});

function sampleSession(id: string, updatedAt: number): ResearchSession {
  return {
    id, goal: `Research question ${id}`, status: "completed", createdAt: 100, updatedAt,
    plan: null, events: [], sources: [], evidence: [], toolCalls: [], decisions: [], errors: [], report: "Verified.",
    verification: { status: "PASS", issues: [], unsupportedClaims: [], missingInformation: [], requiredActions: [] },
    metrics: { startedAt: 100, completedAt: updatedAt, durationMs: updatedAt - 100, llmCalls: 1, toolCalls: 1, searches: 1, sourcesAnalyzed: 2, completedSteps: 1, replans: 0, verificationStatus: "PASS", errors: 0, finalResponseLength: 9, iterations: 2 },
  };
}

describe("Research session persistence", () => {
  it("writes snapshots, reloads sessions, and returns newest history first", async () => {
    const early = sampleSession("11111111-1111-4111-8111-111111111111", 200);
    const late = sampleSession("22222222-2222-4222-8222-222222222222", 300);
    await saveSession(early);
    await saveSession(late);
    await saveSession({ ...early, report: "Updated snapshot" });
    expect((await loadSession(early.id))?.report).toBe("Updated snapshot");
    expect((await listSessions(10)).map(session => session.id)).toEqual([late.id, early.id]);
  });
});
