import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchPlan, VerificationResult } from "@shared/research";

const fakes = vi.hoisted(() => ({ generateStructured: vi.fn(), saveSession: vi.fn() }));
vi.mock("./llm", () => ({ generateStructured: fakes.generateStructured }));
vi.mock("./store", () => ({ saveSession: fakes.saveSession }));
vi.mock("./tools", () => ({
  normalizeSearchQuery: vi.fn((query: string) => query),
  webSearch: vi.fn(async (query: string) => [
    { title: `Evidence for ${query}`, url: "https://example.org/research", domain: "example.org", snippet: "An independently retrieved public search result for the requested question." },
  ]),
  extractPage: vi.fn(),
  calculateBatch: vi.fn((expression: string) => [{ expression, result: expression === "200*500+25000" ? 125000 : 2 }]),
  readUserFile: vi.fn(),
  normalizeSearchRecords: vi.fn((records: Array<{ title: string; url: string; domain: string; snippet: string }>, retrievedAt: number) => records.map((record, index) => ({ ...record, id: `S${index + 1}`, retrievedAt }))),
}));

import { createResearchSession, runResearch } from "./engine";

const initialPlan: ResearchPlan = {
  objective: "Evaluate a student workshop with comparable evidence and practical costs.",
  assumptions: ["The user wants an in-person event."],
  steps: [
    { id: "comparables", title: "Find comparable workshops", objective: "Find in-person college workshop examples", expectedInformation: "Comparable events", completionCriteria: "A relevant source", preferredTool: "web_search", status: "pending" },
    { id: "costs", title: "Estimate participant costs", objective: "Calculate direct cost for 200 learners", expectedInformation: "A deterministic cost calculation", completionCriteria: "Calculator output recorded", preferredTool: "calculator", status: "pending" },
  ],
};

const verifierPass: VerificationResult = { status: "PASS", issues: [], unsupportedClaims: [], missingInformation: [], requiredActions: [] };

function orderedResponses() {
  const plans: Array<ResearchPlan & { reason?: string }> = [
    initialPlan,
    { ...initialPlan, reason: "Search evidence was mismatched; narrowing the plan around in-person campus events." },
  ];
  let decisionNumber = 0;
  fakes.generateStructured.mockImplementation(async ({ promptName }: { promptName: string; user: string }) => {
    if (promptName === "research_plan") return plans[0];
    if (promptName === "revised_research_plan") return plans[1];
    if (promptName === "next_agent_action") {
      decisionNumber += 1;
      if (decisionNumber === 1) return { action: "search", reason: "Find a real comparator before estimating costs.", expectedResult: "Comparable events", stepId: "comparables", query: "in-person university AI workshops", url: null, expression: null, replanFocus: null };
      if (decisionNumber === 2) return { action: "replan", reason: "The first results are online and do not match the in-person constraint.", expectedResult: "A revised scope", stepId: "comparables", query: null, url: null, expression: null, replanFocus: "In-person campus comparators" };
      if (decisionNumber === 3) return { action: "search", reason: "Confirm the narrowed in-person scope.", expectedResult: "An event with a matching setting", stepId: "comparables", query: "campus in-person AI workshop university", url: null, expression: null, replanFocus: null };
      if (decisionNumber === 4) return { action: "calculate", reason: "The brief contains a participant fee and fixed instructor estimate; calculate mechanically.", expectedResult: "Total participant plus instructor cost", stepId: "costs", query: null, url: null, expression: "200*500+25000", replanFocus: null };
      return { action: "verify", reason: "Required work is complete; audit before returning a report.", expectedResult: "Evidence audit", stepId: null, query: null, url: null, expression: null, replanFocus: null };
    }
    if (promptName === "tool_observation") {
      const user = JSON.parse(argumentsForLastCall ?? "{}") as { toolResult?: string; step?: { id?: string } };
      if (observationNumber++ === 0) return { summary: "The first results point to online formats, a mismatch with the in-person campus constraint.", gaps: ["Search evidence is mismatched: no in-person college venue is supported yet."], stepComplete: false, nextMoveHint: "Replan around campus events.", evidence: [] };
      if (user.step?.id === "comparables") return { summary: "A second search returned a matching campus-event lead.", gaps: [], stepComplete: true, nextMoveHint: "Move to the cost calculation.", evidence: [{ claim: "A public search result describes a university event.", sourceId: "S2", supportingText: "An independently retrieved public search result for the requested question.", confidence: 0.74, evidenceType: "direct" }] };
      return { summary: "The deterministic calculator returned the specified arithmetic total.", gaps: [], stepComplete: true, nextMoveHint: "Verify the completed plan and source support.", evidence: [{ claim: "The total cost is 125000.", sourceId: null, supportingText: "200*500+25000 = 125000, executed by calculator.", confidence: 1, evidenceType: "calculated" }] };
    }
    if (promptName === "evidence_verification") return verifierPass;
    if (promptName === "evidence_report") return { report: "# Executive Summary\nA tested research result.\n\n## Evidence\nThe calculator result is labelled as calculated and the source is cited as [S2]." };
    throw new Error(`Unexpected prompt: ${promptName}`);
  });
}
let observationNumber = 0;
let argumentsForLastCall = "{}";

// Capture each request so the mock observation is based on the current, real tool context.
const originalImplementation = fakes.generateStructured.getMockImplementation;
void originalImplementation;

beforeEach(() => {
  fakes.generateStructured.mockReset();
  fakes.saveSession.mockReset().mockResolvedValue(undefined);
  observationNumber = 0;
  orderedResponses();
  const handler = fakes.generateStructured.getMockImplementation();
  fakes.generateStructured.mockImplementation(async (input: { promptName: string; user: string }) => {
    argumentsForLastCall = input.user;
    return handler ? handler(input) : undefined;
  });
});

describe("ResearchPilot autonomous workflow", () => {
  it("emits an evidence-driven live trace, actually replans, and verifies before its report", async () => {
    const session = createResearchSession("Should our college run a two-day AI/ML workshop for 200 students?");
    const events: Array<{ stage: string; title: string; message: string }> = [];
    const result = await runResearch(session, event => events.push(event), { context: "In person; estimate participant cost at ₹500 and instructor cost at ₹25,000." });
    const stages = events.map(event => event.stage);
    expect(stages).toContain("planner");
    expect(stages).toContain("tool_execution");
    expect(stages).toContain("observation");
    expect(stages).toContain("decision");
    expect(stages).toContain("replan");
    expect(stages).toContain("verification");
    expect(stages).toContain("final_report");
    expect(result.metrics.verificationStatus).toBe("PASS");
    expect(result.metrics.replans).toBeGreaterThan(0);
    expect(result.toolCalls.some(call => call.tool === "web_search" && call.ok)).toBe(true);
    expect(result.toolCalls.some(call => call.tool === "calculator" && call.ok)).toBe(true);
    expect(result.report).toContain("Executive Summary");
    expect(result.status).toBe("completed");
    expect(events.findIndex(event => event.stage === "verification")).toBeLessThan(events.findIndex(event => event.stage === "final_report"));
    expect(events.find(event => event.stage === "replan")?.message).toContain("mismatched");
  });

  it("reaches verification after eight real search decisions and a calculation inside the finite action budget", async () => {
    const plan: ResearchPlan = {
      objective: "Collect one source, run a required calculation, then verify.",
      assumptions: [],
      steps: [
        { id: "research", title: "Search the evidence", objective: "Find evidence", expectedInformation: "One source", completionCriteria: "A supported source", preferredTool: "web_search", status: "pending" },
        { id: "calculation", title: "Calculate the result", objective: "Calculate the supplied arithmetic", expectedInformation: "A deterministic result", completionCriteria: "Calculator output recorded", preferredTool: "calculator", status: "pending" },
      ],
    };
    let decisionNumber = 0;
    let searchObservations = 0;
    fakes.generateStructured.mockImplementation(async ({ promptName, user }: { promptName: string; user: string }) => {
      if (promptName === "research_plan") return plan;
      if (promptName === "next_agent_action") {
        decisionNumber += 1;
        if (decisionNumber <= 8) return { action: "search", reason: `Resolve a distinct remaining evidence gap ${decisionNumber}.`, expectedResult: "Evidence", stepId: "research", query: `distinct university workshop evidence ${decisionNumber}`, url: null, expression: null, replanFocus: null };
        return { action: "calculate", reason: "Calculate the supplied input before verification.", expectedResult: "Total", stepId: "calculation", query: null, url: null, expression: "200*500+25000", replanFocus: null };
      }
      if (promptName === "tool_observation") {
        const body = JSON.parse(user) as { tool: string };
        if (body.tool === "web_search") {
          searchObservations += 1;
          return {
            summary: "A public search result was collected; only one distinct source is retained.",
            gaps: searchObservations === 8 ? [] : ["The remaining scoped evidence passes are not complete."],
            stepComplete: searchObservations === 8,
            nextMoveHint: searchObservations === 8 ? "Calculate the user-provided amount." : "Continue the bounded research loop.",
            evidence: searchObservations === 1 ? [{ claim: "A public university workshop result exists.", sourceId: "S1", supportingText: "An independently retrieved public search result.", confidence: 0.7, evidenceType: "direct" }] : [],
          };
        }
        return { summary: "The calculator produced the deterministic total.", gaps: [], stepComplete: true, nextMoveHint: "Verify the arithmetic and source support.", evidence: [{ claim: "The calculated total is 125000.", sourceId: null, supportingText: "200*500+25000 = 125000, executed by calculator.", confidence: 1, evidenceType: "calculated" }] };
      }
      if (promptName === "evidence_verification") return verifierPass;
      if (promptName === "evidence_report") return { report: "# Executive Summary\nVerified bounded-action result." };
      throw new Error(`Unexpected prompt: ${promptName}`);
    });

    const session = createResearchSession("Find evidence and calculate a supplied workshop budget.");
    const result = await runResearch(session, () => undefined);

    expect(result.metrics.iterations).toBe(10);
    expect(result.metrics.toolCalls).toBe(9);
    expect(result.metrics.verificationStatus).toBe("PASS");
    expect(result.status).toBe("completed");
    expect(result.events.map(event => event.stage)).toContain("verification");
    expect(result.events.map(event => event.stage)).toContain("final_report");
  });

  it("does not treat a synthesis-only plan step as missing evidence", async () => {
    const plan: ResearchPlan = {
      objective: "Calculate the user-provided amount and report it after verification.",
      assumptions: [],
      steps: [
        { id: "calc", title: "Calculate the input", objective: "Calculate 2 plus 2", expectedInformation: "The numeric result", completionCriteria: "Calculator returns 4", preferredTool: "calculator", status: "pending" },
        { id: "report", title: "Write a concise report", objective: "Summarize verified result", expectedInformation: "A concise report", completionCriteria: "The report is drafted after verification", preferredTool: "synthesis", status: "pending" },
      ],
    };
    fakes.generateStructured.mockImplementation(async ({ promptName }: { promptName: string }) => {
      if (promptName === "research_plan") return plan;
      if (promptName === "next_agent_action") return { action: "calculate", reason: "The calculator step is the only pending evidence work.", expectedResult: "4", stepId: "calc", query: null, url: null, expression: "2+2", replanFocus: null };
      if (promptName === "tool_observation") return { summary: "The deterministic calculator returned 4.", gaps: [], stepComplete: true, nextMoveHint: "Verify the result, then report it.", evidence: [{ claim: "2 plus 2 equals 4.", sourceId: null, supportingText: "2+2 = 4, executed by calculator.", confidence: 1, evidenceType: "calculated" }] };
      if (promptName === "evidence_verification") return verifierPass;
      if (promptName === "evidence_report") return { report: "# Result\n2 + 2 = 4 (calculated)." };
      throw new Error(`Unexpected prompt: ${promptName}`);
    });

    const result = await runResearch(createResearchSession("Calculate 2+2 and report the result."), () => undefined);

    expect(result.status).toBe("completed");
    expect(result.metrics.verificationStatus).toBe("PASS");
    expect(result.plan?.steps.every(step => step.status === "completed")).toBe(true);
    expect(result.events.findIndex(event => event.stage === "verification")).toBeLessThan(result.events.findIndex(event => event.stage === "final_report"));
  });
});
