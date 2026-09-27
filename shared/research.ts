export type AgentStatus = "queued" | "running" | "completed" | "failed";

export type TraceStage =
  | "planner"
  | "decision"
  | "tool_execution"
  | "observation"
  | "replan"
  | "verification"
  | "final_report"
  | "error";

export interface AgentEvent {
  id: number;
  timestamp: number;
  stage: TraceStage;
  title: string;
  message: string;
  tool?: "web_search" | "url_extractor" | "calculator" | "file_reader";
  details?: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  title: string;
  objective: string;
  expectedInformation: string;
  completionCriteria: string;
  preferredTool: "web_search" | "url_extractor" | "calculator" | "synthesis";
  status: "pending" | "in_progress" | "completed";
}

export interface ResearchPlan {
  objective: string;
  assumptions: string[];
  steps: PlanStep[];
}

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  retrievedAt: number;
  relevance?: string;
  extractedText?: string;
}

export interface ResearchEvidence {
  id: string;
  claim: string;
  sourceId?: string;
  supportingText: string;
  confidence: number;
  evidenceType: "direct" | "calculated" | "inferred" | "estimate" | "user_provided";
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  outputSummary: string;
  timestamp: number;
  ok: boolean;
}

export interface VerificationResult {
  status: "PASS" | "FAIL";
  issues: string[];
  unsupportedClaims: string[];
  missingInformation: string[];
  requiredActions: string[];
}

export interface ExecutionMetrics {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  llmCalls: number;
  toolCalls: number;
  searches: number;
  sourcesAnalyzed: number;
  completedSteps: number;
  replans: number;
  verificationStatus: "PENDING" | "PASS" | "FAIL";
  errors: number;
  finalResponseLength: number;
  iterations: number;
}

export interface ResearchSession {
  id: string;
  goal: string;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
  plan: ResearchPlan | null;
  events: AgentEvent[];
  sources: ResearchSource[];
  evidence: ResearchEvidence[];
  toolCalls: ToolCallRecord[];
  decisions: Array<{ action: string; reason: string; timestamp: number }>;
  errors: string[];
  verification: VerificationResult | null;
  report: string;
  metrics: ExecutionMetrics;
}

export interface ResearchRequest {
  goal: string;
  context?: string;
}
