import { randomUUID } from "node:crypto";
import type {
  AgentEvent, ExecutionMetrics, PlanStep, ResearchEvidence, ResearchPlan,
  ResearchSession, ResearchSource, ToolCallRecord, VerificationResult,
} from "@shared/research";
import { calculateBatch, extractPage, normalizeSearchQuery, normalizeSearchRecords, readUserFile, webSearch } from "./tools";
import { generateStructured } from "./llm";
import { decisionPrompt, observationPrompt, plannerPrompt, replannerPrompt, synthesisPrompt, verifierPrompt } from "../../app/prompts";
import { saveSession } from "./store";

type Action = "search" | "extract" | "calculate" | "read_file" | "replan" | "verify" | "finish";
type Decision = {
  action: Action;
  reason: string;
  expectedResult: string;
  stepId: string | null;
  query: string | null;
  url: string | null;
  expression: string | null;
  replanFocus: string | null;
};

type AttachedFile = { name: string; content: string };
type EventSink = (event: AgentEvent) => void;

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const MAX_ACTION_TURNS = 12;
const planSchema = {
  type: "object",
  properties: {
    steps: { type: "array", minItems: 2, maxItems: 4, items: {
      type: "object",
      properties: {
        id: { type: "string" }, title: { type: "string" }, objective: { type: "string" },
        expectedInformation: { type: "string" }, completionCriteria: { type: "string" },
        preferredTool: { type: "string", enum: ["web_search", "url_extractor", "calculator", "synthesis"] },
      },
      required: ["id", "title", "objective", "expectedInformation", "completionCriteria", "preferredTool"],
      additionalProperties: false,
    } },
    objective: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
  },
  required: ["steps", "objective", "assumptions"],
  additionalProperties: false,
};
const decisionSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search", "extract", "calculate", "read_file", "replan", "verify", "finish"] },
    reason: { type: "string" }, expectedResult: { type: "string" },
    stepId: nullableString, query: nullableString, url: nullableString, expression: nullableString, replanFocus: nullableString,
  },
  required: ["action", "reason"],
  additionalProperties: false,
};
const observationSchema = {
  type: "object",
  properties: {
    summary: { type: "string" }, gaps: { type: "array", items: { type: "string" } },
    stepComplete: { type: "boolean" }, nextMoveHint: { type: "string" },
    evidence: { type: "array", items: { type: "object", properties: {
      claim: { type: "string" }, sourceId: nullableString, supportingText: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidenceType: { type: "string", enum: ["direct", "calculated", "inferred", "estimate", "user_provided"] },
    }, required: ["claim", "supportingText"], additionalProperties: false } },
  },
  required: ["summary"],
  additionalProperties: false,
};
const verificationSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["PASS", "FAIL"] },
    issues: { type: "array", items: { type: "string" } },
    unsupportedClaims: { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    requiredActions: { type: "array", items: { type: "string" } },
  },
  required: ["status"],
  additionalProperties: false,
};

function newMetrics(): ExecutionMetrics {
  return {
    startedAt: Date.now(), llmCalls: 0, toolCalls: 0, searches: 0, sourcesAnalyzed: 0,
    completedSteps: 0, replans: 0, verificationStatus: "PENDING", errors: 0, finalResponseLength: 0, iterations: 0,
  };
}

export function createResearchSession(goal: string, context = ""): ResearchSession {
  const cleanGoal = goal.trim().replace(/\s+/g, " ").slice(0, 3_000);
  const now = Date.now();
  return {
    id: randomUUID(), goal: cleanGoal, status: "running", createdAt: now, updatedAt: now,
    plan: null, events: [], sources: [], evidence: [], toolCalls: [], decisions: [], errors: [],
    verification: null, report: "", metrics: newMetrics(),
  };
}

function createDefaultSteps(goal: string): PlanStep[] {
  return [
    {
      id: "step_1",
      title: "Investigate primary evidence and baseline metrics",
      objective: `Find core data points, costs, precedents, and facts relevant to: ${goal}`.slice(0, 600),
      expectedInformation: "Factual evidence, industry benchmarks, and authoritative data",
      completionCriteria: "Key evidence collected from authoritative sources",
      preferredTool: "web_search",
      status: "pending",
    },
    {
      id: "step_2",
      title: "Synthesize findings and assess feasibility",
      objective: `Evaluate trade-offs, aggregate gathered evidence, and verify conclusions for: ${goal}`.slice(0, 600),
      expectedInformation: "Clear, verifiable conclusions addressing the research goal",
      completionCriteria: "Comprehensive summary and verification complete",
      preferredTool: "synthesis",
      status: "pending",
    },
  ];
}

function validatePlan(candidate: Partial<ResearchPlan> | null | undefined, fallbackGoal = ""): ResearchPlan {
  const rawSteps = Array.isArray(candidate?.steps) && candidate!.steps.length > 0
    ? candidate!.steps
    : createDefaultSteps(fallbackGoal);
  const slicedSteps = rawSteps.slice(0, 4);
  if (slicedSteps.length === 1) {
    slicedSteps.push({
      id: "step_2",
      title: "Synthesize findings",
      objective: "Consolidate and verify evidence",
      expectedInformation: "Comprehensive summary",
      completionCriteria: "Key questions answered",
      preferredTool: "synthesis",
      status: "pending",
    });
  }
  const seenIds = new Set<string>();
  const steps: PlanStep[] = slicedSteps.map((step, index) => {
    let id = String(step.id || `step_${index + 1}`).slice(0, 40);
    if (seenIds.has(id)) {
      id = `${id}_${index + 1}`;
    }
    seenIds.add(id);
    return {
      id,
      title: String(step.title || `Step ${index + 1}`).slice(0, 160),
      objective: String(step.objective || "").slice(0, 600),
      expectedInformation: String(step.expectedInformation || "").slice(0, 300),
      completionCriteria: String(step.completionCriteria || "").slice(0, 300),
      preferredTool: (step.preferredTool as any) || "web_search",
      status: "pending" as const,
    };
  });
  return {
    objective: String(candidate?.objective || `Investigate: ${fallbackGoal}`).slice(0, 500),
    assumptions: Array.isArray(candidate?.assumptions) && candidate!.assumptions.length > 0
      ? candidate!.assumptions.map(String).slice(0, 10)
      : ["Initial evidence should be gathered from primary authoritative sources"],
    steps,
  };
}

function stepFor(session: ResearchSession, stepId: string | null): PlanStep | null {
  if (!session.plan) return null;
  if (stepId) {
    const requested = session.plan.steps.find(step => step.id === stepId);
    if (requested && requested.preferredTool !== "synthesis") return requested;
  }
  return session.plan.steps.find(step => step.status !== "completed" && step.preferredTool !== "synthesis") ?? null;
}

function pendingEvidenceSteps(session: ResearchSession): PlanStep[] {
  return session.plan?.steps.filter(step => step.status !== "completed" && step.preferredTool !== "synthesis") ?? [];
}

function toolRecord(session: ResearchSession, record: Omit<ToolCallRecord, "id" | "timestamp">): void {
  session.toolCalls.push({ ...record, id: randomUUID(), timestamp: Date.now() });
  session.metrics.toolCalls += 1;
}

function contextSnapshot(session: ResearchSession): string {
  return JSON.stringify({
    goal: session.goal,
    plan: session.plan,
    completedSteps: session.plan?.steps.filter(step => step.status === "completed").map(step => ({ id: step.id, title: step.title })) ?? [],
    observations: session.events.filter(event => event.stage === "observation").slice(-3).map(event => event.message?.slice(0, 200)),
    sources: session.sources.slice(-4).map(source => ({ id: source.id, title: source.title?.slice(0, 80), url: source.url, snippet: source.snippet?.slice(0, 150) })),
    evidence: session.evidence.slice(-6).map(e => ({ id: e.id, claim: e.claim?.slice(0, 120), sourceId: e.sourceId })),
    tools: session.toolCalls.slice(-3).map(t => ({ tool: t.tool, success: !t.error })),
    decisions: session.decisions.slice(-3).map(d => ({ action: d.action, reason: d.reason?.slice(0, 80) })),
    errors: session.errors.slice(-2),
  });
}

export async function runResearch(
  session: ResearchSession,
  sink: EventSink,
  options: { context?: string; file?: AttachedFile } = {},
): Promise<ResearchSession> {
  let persistenceWarningSent = false;
  let latestObservation = "No observations yet.";
  let forcedReplan = false;
  let verificationCycles = 0;

  const persist = async () => {
    session.updatedAt = Date.now();
    try {
      await saveSession(session);
    } catch (error) {
      session.metrics.errors += 1;
      const message = error instanceof Error ? error.message : "Unknown database error";
      if (!persistenceWarningSent) {
        persistenceWarningSent = true;
        session.errors.push(message);
      }
    }
  };

  const emit = async (stage: AgentEvent["stage"], title: string, message: string, details?: Record<string, unknown>, tool?: AgentEvent["tool"]) => {
    const event: AgentEvent = { id: session.events.length + 1, timestamp: Date.now(), stage, title, message, ...(details ? { details } : {}), ...(tool ? { tool } : {}) };
    session.events.push(event);
    session.updatedAt = event.timestamp;
    await persist();
    sink(event);
  };

  const structured = async <T>(input: Parameters<typeof generateStructured>[0]): Promise<T> => {
    session.metrics.llmCalls += 1;
    return generateStructured<T>(input);
  };

  try {
    await emit("planner", "Planner · decomposing the question", "The planning model is converting the fresh research goal into testable subtasks.", { goal: session.goal });
    let plan: ResearchPlan;
    try {
      const candidatePlan = await structured<ResearchPlan>({
        promptName: "research_plan", system: plannerPrompt,
        user: JSON.stringify({ goal: session.goal, context: options.context ?? "", uploadedFile: options.file ? { name: options.file.name, characters: options.file.content.length } : null }),
        schema: planSchema,
      });
      plan = validatePlan(candidatePlan, session.goal);
    } catch (planError) {
      console.warn("[Research Engine] Planner generation failed; using goal-aligned fallback plan:", planError);
      plan = validatePlan(null, session.goal);
    }
    session.plan = plan;
    await emit("planner", "Plan committed", `${session.plan.steps.length} subtasks generated; each includes completion criteria and a preferred tool.`, { plan: session.plan });

    let turn = 0;
    let finished = false;
    while (!finished && turn < MAX_ACTION_TURNS) {
      turn += 1;
      session.metrics.iterations = turn;
      const pending = pendingEvidenceSteps(session);
      if (!pending.length && !session.verification) {
        await emit("decision", "Decision · all planned evidence gathered", "The state evaluator found every plan step complete; it is routing to verification.", { action: "verify", basis: "All required plan steps completed" });
        session.decisions.push({ action: "verify", reason: "All required plan steps completed", timestamp: Date.now() });
        await verifyAndContinue();
        if ((session.verification as VerificationResult | null)?.status === "PASS") finished = await synthesize();
        continue;
      }
      if (!pending.length && session.verification?.status === "PASS") {
        finished = await synthesize();
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
      const decision = await structured<Decision>({
        promptName: "next_agent_action", system: decisionPrompt,
        user: JSON.stringify({ state: contextSnapshot(session), latestObservation, forcedReplan, fileAvailable: Boolean(options.file), fileName: options.file?.name ?? null, remainingTurns: MAX_ACTION_TURNS - turn }),
        schema: decisionSchema,
      });
      let rawAction = String((decision as any)?.action || "").toLowerCase().trim();
      if (rawAction === "web_search" || rawAction === "websearch") rawAction = "search";
      if (rawAction === "url_extractor" || rawAction === "extractor") rawAction = "extract";
      if (rawAction === "calculator") rawAction = "calculate";
      if (rawAction === "synthesis" || rawAction === "synthesize") rawAction = "finish";
      if (rawAction === "verification") rawAction = "verify";
      if (!["search", "extract", "calculate", "read_file", "replan", "verify", "finish"].includes(rawAction)) {
        if ((decision as any)?.query) rawAction = "search";
        else if ((decision as any)?.url) rawAction = "extract";
        else rawAction = pending.length ? "search" : "verify";
      }
      decision.action = rawAction as Action;
      if (!decision.reason) decision.reason = `Proceeding with ${rawAction}`;

      const step = stepFor(session, decision.stepId);
      const effectiveAction: Action = forcedReplan && session.metrics.replans < 3 ? "replan" : decision.action;
      forcedReplan = false;
      session.decisions.push({ action: effectiveAction, reason: (decision.reason || "").slice(0, 800), timestamp: Date.now() });
      await emit("decision", `Decision · ${effectiveAction.replace("_", " ")}`, decision.reason, { action: effectiveAction, stepId: step?.id ?? null, expectedResult: decision.expectedResult });

      if (effectiveAction === "replan") {
        if (session.metrics.replans >= 3) {
          await emit("decision", "Re-plan limit reached", "The agent retained its current plan to prevent an unbounded workflow.", { maxReplans: 3 });
          if (step) step.status = "in_progress";
          continue;
        }
        const previous = session.plan;
        const newPlan = await structured<ResearchPlan & { reason?: string }>({
          promptName: "revised_research_plan", system: replannerPrompt,
          user: JSON.stringify({ goal: session.goal, previousPlan: previous, state: contextSnapshot(session), focus: decision.replanFocus ?? latestObservation }),
          schema: { ...planSchema, properties: { ...planSchema.properties, reason: { type: "string" } }, required: [...planSchema.required, "reason"] },
        });
        const revised = validatePlan(newPlan, session.goal);
        // Preserve completion only where the new objective still matches a completed step.
        for (const nextStep of revised.steps) {
          const oldDone = previous?.steps.find(old => old.status === "completed" && old.objective.toLowerCase() === nextStep.objective.toLowerCase());
          if (oldDone) nextStep.status = "completed";
        }
        session.plan = revised;
        session.metrics.replans += 1;
        await emit("replan", "Plan updated · evidence changed the route", newPlan.reason || decision.reason, { previousPlan: previous, updatedPlan: revised, trigger: latestObservation });
        continue;
      }

      if (effectiveAction === "verify") {
        await verifyAndContinue();
        if ((session.verification as VerificationResult | null)?.status === "PASS") finished = await synthesize();
        continue;
      }
      if (effectiveAction === "finish") {
        if (session.verification?.status !== "PASS") {
          await emit("decision", "Finish deferred · verification is mandatory", "The orchestrator rejected a premature finish request and is routing the actual evidence to verification.", { rejectedAction: "finish", requiredNextAction: "verify" });
          await verifyAndContinue();
          if ((session.verification as VerificationResult | null)?.status === "PASS") finished = await synthesize();
        } else finished = await synthesize();
        continue;
      }

      if (!step) {
        await emit("observation", "Observation · no open plan step", "No open subtask was available; the state loop will re-evaluate the plan.", { pendingSteps: 0 });
        forcedReplan = true;
        continue;
      }
      step.status = "in_progress";
      let toolName = "";
      let toolInput: Record<string, unknown> = {};
      let toolOutput = "";
      let observationExtra: Record<string, unknown> = {};
      let usedSources: ResearchSource[] = [];
      let toolOk = true;

      try {
        if (effectiveAction === "search") {
          toolName = "web_search";
          const suggestedQuery = (decision.query || step.objective || step.expectedInformation).slice(0, 1_200);
          const query = normalizeSearchQuery(suggestedQuery);
          toolInput = { query, suggestedQuery, maxResults: 5 };
          await emit("tool_execution", "Tool · live web search", `Searching DuckDuckGo for: ${query}`, { query, provider: "DuckDuckGo HTML Search", resultLimit: 5 }, "web_search");
          const results = await webSearch(query, 5);
          usedSources = normalizeSearchRecords(results.map(result => ({ ...result, snippet: result.snippet })), Date.now());
          for (const source of usedSources) source.id = `S${session.sources.length + 1 + usedSources.indexOf(source)}`;
          const known = new Set(session.sources.map(source => source.url));
          usedSources = usedSources.filter(source => !known.has(source.url));
          session.sources.push(...usedSources);
          session.metrics.searches += 1;
          session.metrics.sourcesAnalyzed = session.sources.length;
          toolOutput = JSON.stringify(usedSources.map(source => ({ id: source.id, title: source.title, url: source.url, snippet: source.snippet })));
          observationExtra = { sourceIds: usedSources.map(source => source.id), resultCount: usedSources.length };
        } else if (effectiveAction === "extract") {
          toolName = "url_extractor";
          const target = (decision.url || "").trim().toLowerCase();
          const source = session.sources.find(item =>
            item.url.toLowerCase() === target ||
            item.id.toLowerCase() === target ||
            item.url.toLowerCase().replace(/\/$/, "") === target.replace(/\/$/, "") ||
            (target && item.url.toLowerCase().includes(target))
          ) || session.sources.find(item => !item.extractedText) || session.sources[0];
          if (!source) throw new Error("URL extraction requires a URL already discovered by the live search tool.");
          toolInput = { url: source.url, sourceId: source.id };
          await emit("tool_execution", "Tool · extracting a cited source", `Fetching readable evidence from ${source.domain}.`, { sourceId: source.id, url: source.url }, "url_extractor");
          const page = await extractPage(source.url);
          source.title = page.title || source.title;
          source.extractedText = page.text;
          observationExtra = { sourceId: source.id, charactersExtracted: page.text.length };
          toolOutput = JSON.stringify({ sourceId: source.id, title: source.title, url: source.url, text: page.text.slice(0, 5_500) });
        } else if (effectiveAction === "calculate") {
          toolName = "calculator";
          const expression = (decision.expression || "").slice(0, 900);
          toolInput = { expression };
          await emit("tool_execution", "Tool · deterministic calculator", `Evaluating the validated expression: ${expression || "(empty)"}`, { expression }, "calculator");
          const calculations = calculateBatch(expression);
          observationExtra = { expression, calculations };
          toolOutput = JSON.stringify({ expression, calculations });
          for (const calculation of calculations) {
            session.evidence.push({ id: randomUUID(), claim: `${calculation.expression} = ${calculation.result}`, supportingText: `Executed by the deterministic arithmetic parser: ${calculation.expression} = ${calculation.result}.`, confidence: 1, evidenceType: "calculated" });
          }
        } else if (effectiveAction === "read_file") {
          toolName = "file_reader";
          if (!options.file) throw new Error("No supported user file was attached to this research run.");
          toolInput = { name: options.file.name, characters: options.file.content.length };
          await emit("tool_execution", "Tool · user file reader", `Inspecting ${options.file.name} (${options.file.content.length.toLocaleString()} characters).`, { fileName: options.file.name }, "file_reader");
          const result = readUserFile(options.file.name, options.file.content);
          observationExtra = { fileName: result.name, characters: result.characters };
          toolOutput = JSON.stringify({ ...result, preview: result.preview.slice(0, 8_000) });
        }
      } catch (error) {
        toolOk = false;
        session.metrics.errors += 1;
        const message = error instanceof Error ? error.message : "The tool failed unexpectedly.";
        session.errors.push(`${toolName || effectiveAction}: ${message}`);
        observationExtra = { error: message, partialEvidenceAvailable: session.sources.length > 0 || session.evidence.length > 0 };
        toolOutput = JSON.stringify({ error: message });
        await emit("error", `${toolName || effectiveAction} · tool error`, `${message} The agent will keep prior evidence and choose its next action from the surviving state.`, observationExtra, (toolName || undefined) as AgentEvent["tool"]);
      }

      toolRecord(session, { tool: toolName || effectiveAction, input: toolInput, outputSummary: toolOutput.slice(0, 1_500), ok: toolOk });
      session.metrics.completedSteps = session.plan?.steps.filter(item => item.status === "completed").length ?? 0;
      const observation = await structured<{
        summary: string; gaps: string[]; stepComplete: boolean; nextMoveHint: string;
        evidence: Array<{ claim: string; sourceId: string | null; supportingText: string; confidence: number; evidenceType: ResearchEvidence["evidenceType"] }>;
      }>({
        promptName: "tool_observation", system: observationPrompt,
        user: JSON.stringify({ goal: session.goal, step, tool: toolName, toolResult: toolOutput.slice(0, 2_000), priorEvidence: session.evidence.slice(-6).map(e => ({ id: e.id, claim: e.claim?.slice(0, 150) })), sources: usedSources.map(source => ({ id: source.id, url: source.url, title: source.title })), toolError: toolOk ? null : observationExtra.error }),
        schema: observationSchema,
      });
      latestObservation = observation.summary;
      for (const item of (observation.evidence || [])) {
        if (item.sourceId && !session.sources.some(source => source.id === item.sourceId)) continue;
        const { sourceId, ...evidenceItem } = item;
        session.evidence.push({
          ...evidenceItem,
          ...(sourceId ? { sourceId } : {}),
          id: randomUUID(),
          confidence: Math.max(0, Math.min(item.confidence ?? 0.8, 1)),
          evidenceType: item.evidenceType || "direct",
        });
      }
      if (observation.stepComplete && toolOk) step.status = "completed";
      session.metrics.completedSteps = session.plan?.steps.filter(item => item.status === "completed").length ?? 0;
      const gaps = observation.gaps || [];
      await emit("observation", "Observation · state updated", observation.summary, { stepId: step.id, stepComplete: step.status === "completed", gaps, nextMoveHint: observation.nextMoveHint || "", ...observationExtra });
      if (gaps.length && /mismatch|does not match|irrelevant|wrong audience|wrong region|not comparable|scope changed|constraint/i.test(`${observation.summary} ${gaps.join(" ")}`)) {
        forcedReplan = session.metrics.replans < 3;
      }
    }

    if (!session.report) {
      if (session.verification?.status !== "PASS") {
        await emit("verification", "Verification · final bounded review", "The autonomous loop reached its safety limit. A final check records missing evidence rather than implying it passed.", { iterationLimit: MAX_ACTION_TURNS });
        session.verification = {
          status: "FAIL", issues: ["The agent reached its maximum action count before verification passed."],
          unsupportedClaims: [], missingInformation: pendingEvidenceSteps(session).map(step => step.expectedInformation),
          requiredActions: ["Run another focused research cycle."],
        };
        session.metrics.verificationStatus = "FAIL";
      }
      await synthesize();
    }
    session.status = "completed";
    session.metrics.completedAt = Date.now();
    session.metrics.durationMs = session.metrics.completedAt - session.metrics.startedAt;
    session.metrics.finalResponseLength = session.report.length;
    await emit("final_report", "Final report · research run complete", "The final report was synthesized from this run's actual sources, tool results, and verification outcome.", { verification: session.verification?.status, reportCharacters: session.report.length, metrics: session.metrics, report: session.report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The research workflow failed unexpectedly.";
    session.status = "failed";
    session.errors.push(message);
    session.metrics.errors += 1;
    session.metrics.completedAt = Date.now();
    session.metrics.durationMs = session.metrics.completedAt - session.metrics.startedAt;
    await emit("error", "Research run failed safely", message, { retryable: true });
  }

  return session;

  async function verifyAndContinue(): Promise<void> {
    verificationCycles += 1;
    await emit("verification", "Verification · checking the actual evidence", "The verifier is auditing completeness, source support, relevance, consistency, calculations, and uncertainty before any final response.", { cycle: verificationCycles, sourceCount: session.sources.length, evidenceCount: session.evidence.length });
    const result = await structured<VerificationResult>({
      promptName: "evidence_verification", system: verifierPrompt,
      user: JSON.stringify({ goal: session.goal, plan: session.plan, reportDraft: session.report || null, sources: session.sources.slice(-8).map(source => ({ id: source.id, title: source.title?.slice(0, 100), url: source.url, snippet: source.snippet?.slice(0, 200), extractedText: source.extractedText?.slice(0, 400) })), evidence: session.evidence.slice(-12), toolCalls: session.toolCalls.slice(-5), previousVerification: session.verification }),
      schema: verificationSchema,
    });
    const unfinished = pendingEvidenceSteps(session);
    const issues = [...result.issues];
    const requiredActions = [...result.requiredActions];
    let status = result.status;
    if (unfinished.length) {
      status = "FAIL";
      issues.push(`${unfinished.length} required plan step(s) remain incomplete.`);
      requiredActions.push(...unfinished.map(step => `Research: ${step.expectedInformation}`));
    }
    if (!session.sources.length && session.evidence.every(item => item.evidenceType !== "calculated" && item.evidenceType !== "user_provided")) {
      status = "FAIL";
      issues.push("No independently retrieved source supports this report.");
      requiredActions.push("Search for primary sources or clearly report that web research was unavailable.");
    }
    session.verification = { ...result, status, issues: Array.from(new Set(issues)), requiredActions: Array.from(new Set(requiredActions)) };
    session.metrics.verificationStatus = status;
    await emit("verification", `Verification · ${status}`, status === "PASS" ? "The evidence and completed plan passed the current verification checks." : "Verification identified gaps. The agent will re-plan and continue rather than returning an unverified report.", { ...session.verification });
    if (status === "FAIL" && verificationCycles <= 2 && session.metrics.replans < 3) {
      session.verification = null;
      forcedReplan = true;
      await emit("replan", "Plan update triggered by verification", "Verification failure is being fed back into the live planner; the next decision will target its specific required actions.", { previousResult: result, focusedActions: Array.from(new Set(requiredActions)) });
    }
  }

  async function synthesize(): Promise<boolean> {
    if (!session.verification) return false;
    session.metrics.llmCalls += 1;
    const response = await generateStructured<{ report: string }>({
      promptName: "evidence_report", system: synthesisPrompt,
      user: JSON.stringify({ goal: session.goal, plan: session.plan, evidence: session.evidence.slice(-12).map(e => ({ id: e.id, claim: e.claim, sourceId: e.sourceId, confidence: e.confidence, evidenceType: e.evidenceType })), sources: session.sources.slice(-8).map(source => ({ id: source.id, title: source.title?.slice(0, 100), url: source.url, domain: source.domain, snippet: source.snippet?.slice(0, 200), extractedText: source.extractedText?.slice(0, 500) })), calculations: session.toolCalls.filter(tool => tool.tool === "calculator").slice(-3), verification: session.verification, limitations: session.errors.slice(-3) }),
      schema: { type: "object", properties: { report: { type: "string" } }, required: ["report"], additionalProperties: false },
    });
    const report = response.report.trim();
    if (!report) throw new Error("The report writer returned an empty response.");
    session.report = report.slice(0, 30_000);
    for (const step of session.plan?.steps ?? []) {
      if (step.preferredTool === "synthesis") step.status = "completed";
    }
    session.metrics.completedSteps = session.plan?.steps.filter(step => step.status === "completed").length ?? 0;
    return true;
  }
}
