import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Brain,
  Calculator,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  FileText,
  FlaskConical,
  Globe2,
  Layers,
  Lock,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap
} from "lucide-react";

interface CaseStudy {
  id: string;
  tag: string;
  title: string;
  goal: string;
  plan: string[];
  toolAction: string;
  calc: string;
  verification: string;
  synthesisTitle: string;
  synthesisSummary: string;
  metrics: { cost: string; time: string; sources: number; confidence: string };
}

const caseStudies: CaseStudy[] = [
  {
    id: "hackathon",
    tag: "Higher Ed & Budget",
    title: "University AI/ML Workshop Feasibility",
    goal: "Should our university host a two-day AI/ML workshop for 200 students? Compare venue, compute, instructor costs, and calculate net cost per attendee.",
    plan: [
      "Gather collegiate venue & catering baselines ($300–$500/student)",
      "Retrieve cloud GPU credit grants & sponsor subsidies",
      "Calculate deterministic budget breakdown via AST engine",
      "Audit claims against primary higher-ed workshop filings"
    ],
    toolAction: "DuckDuckGo: 'collegiate AI workshop budget 200 participants' -> Extracted 4 primary university expenditure reports",
    calc: "(200 * 450) + 18000 - 15000 = $93,000 net ($465 / attendee)",
    verification: "4 citations audited against primary sources. 0 ungrounded claims. Verification gate: PASS.",
    synthesisTitle: "Collegiate AI/ML Workshop Feasibility Assessment",
    synthesisSummary: "Net attendee cost is projected at $465 after cloud compute grants. High student demand (82% pre-interest) offsets fixed venue overhead.",
    metrics: { cost: "$93,000", time: "3.8s", sources: 4, confidence: "98.4%" }
  },
  {
    id: "platforms",
    tag: "Enterprise Tech Stack",
    title: "AI Coding Assistant Market Audit",
    goal: "Compare GitHub Copilot, Cursor, and Windsurf by enterprise pricing, SOC2 compliance, and context indexing capabilities.",
    plan: [
      "Extract current 2026 enterprise seat pricing tables",
      "Cross-verify SOC2 Type II and zero-retention policies",
      "Compare local repo semantic graph indexing mechanisms",
      "Synthesize feature-matrix with verified primary citations"
    ],
    toolAction: "Anti-SSRF URL Reader: Fetched pricing & security whitepapers across GitHub, Anysphere, and Codeium",
    calc: "Seat Delta: ($39/mo * 120 seats) vs ($20/mo * 120 seats) = $27,360 annual difference",
    verification: "All pricing tiers verified against current vendor docs. No hallucinated feature claims.",
    synthesisTitle: "2026 Enterprise AI Coding Assistant Evaluation",
    synthesisSummary: "Cursor leads in custom codebase indexing speed; GitHub Copilot maintains deepest audit logging for regulated compliance teams.",
    metrics: { cost: "$27.3K delta", time: "4.2s", sources: 6, confidence: "99.1%" }
  },
  {
    id: "heatpump",
    tag: "Commercial Cleantech",
    title: "Commercial Heat-Pump Retrofit ROI",
    goal: "What empirical evidence supports air-to-water heat-pump retrofits for 15,000 sq ft office buildings? Calculate payback period and COP.",
    plan: [
      "Query seasonal COP ratings for commercial VRF systems",
      "Extract utility kWh rebate structures and tax credits",
      "Model amortized operational cost vs gas boiler legacy system",
      "Independent verification pass over DOE benchmark datasets"
    ],
    toolAction: "DuckDuckGo: 'commercial VRF heat pump COP 3.2 building efficiency DOE' -> Ingested 3 energy laboratory reports",
    calc: "Annual savings: $14,200/yr on $52,000 net capex = 3.66 years payback period",
    verification: "COP metrics ground-truthed against NREL commercial building data. Gate passed.",
    synthesisTitle: "Commercial Heat-Pump Decarbonization & Payback Model",
    synthesisSummary: "Average COP of 3.4 reduces annualized HVAC operating cost by 31%, achieving payback in 3.66 years with local decarbonization credits.",
    metrics: { cost: "3.66 yrs ROI", time: "4.6s", sources: 5, confidence: "97.8%" }
  }
];

const agentWorkflowSteps = [
  {
    num: "01",
    phase: "PLAN",
    title: "Structured Task Decomposition",
    desc: "Decomposes unstructured user goals into 2–4 typed, executable subtasks with completion criteria and tool preferences.",
    badge: "Strict JSON Schema",
    color: "violet",
    icon: Brain,
  },
  {
    num: "02",
    phase: "ACT",
    title: "Sandboxed Tool Dispatch",
    desc: "Autonomous single-action selection: live DuckDuckGo web search, SSRF-safe URL reader, deterministic calculator, or file reader.",
    badge: "Closed Allowlist",
    color: "blue",
    icon: Globe2,
  },
  {
    num: "03",
    phase: "OBSERVE",
    title: "Empirical Evidence Extraction",
    desc: "Analyzes actual tool output against current criteria, extracting verified claims while flagging missing parameters and data gaps.",
    badge: "Empirical Grounding",
    color: "amber",
    icon: Activity,
  },
  {
    num: "04",
    phase: "RE-PLAN",
    title: "Adaptive State-Aware Re-planning",
    desc: "When negative observations, dead-ends, or missing inputs occur, the agent dynamically revises its remaining steps.",
    badge: "Dynamic Recovery",
    color: "cyan",
    icon: RefreshCw,
  },
  {
    num: "05",
    phase: "VERIFY",
    title: "Independent Evidence Gate",
    desc: "A separate verification pass audits the entire evidence chain. Unsupported claims reject the run back to research.",
    badge: "Verification Barrier",
    color: "rose",
    icon: ShieldCheck,
  },
  {
    num: "06",
    phase: "SYNTHESIZE",
    title: "Evidence-Grounded Report",
    desc: "Drafts a comprehensive decision paper with explicit source attribution [S1], labeled estimates, and actionable recommendations.",
    badge: "Verified Synthesis",
    color: "mint",
    icon: FileText,
  },
];

const toolArsenal = [
  {
    title: "Live DuckDuckGo HTML Search",
    desc: "Retrieves genuine real-time web results without expensive third-party search APIs. Normalizes titles, URLs, and snippets.",
    tag: "Live Web Crawler",
    icon: Search,
    detail: "No API key needed · Snippet parsing · Multi-query retry",
  },
  {
    title: "Anti-SSRF Public URL Extractor",
    desc: "Fetches full public HTML pages discovered during search. Enforces private IP blacklists, size bounds, and timeout limits.",
    tag: "Deep Reader",
    icon: Globe2,
    detail: "Guarded HTTP(S) · Sanitized Markdown · Size capped",
  },
  {
    title: "Deterministic Math Engine",
    desc: "A secure AST-based arithmetic evaluator. Calculates budgets, ROI, and percentages with zero shell or eval execution.",
    tag: "Safe Calculator",
    icon: Calculator,
    detail: "Safe AST evaluation · Parentheses precedence · Equations",
  },
  {
    title: "Document Ingestor (CSV/JSON/MD)",
    desc: "Accepts local text-based datasets, spreadsheets, or briefs. Ingests schema and row contents securely into context.",
    tag: "File Reader",
    icon: FileCode2,
    detail: "CSV / JSON / Markdown · 80 KB bounded · Context isolation",
  },
];

export default function Landing() {
  const [, setLocation] = useLocation();
  const [selectedCase, setSelectedCase] = useState<CaseStudy>(caseStudies[0]);
  const [activeStep, setActiveStep] = useState(0);

  function handleLaunchCase(goal: string) {
    setLocation(`/app?goal=${encodeURIComponent(goal)}`);
  }

  return (
    <div className="landing-root">
      {/* Background ambient lighting matching the warm porcelain & light sage theme */}
      <div className="landing-glow glow-top" />
      <div className="landing-glow glow-right" />

      {/* Navigation Header */}
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Link href="/" className="landing-brand">
            <div className="landing-brand-mark">
              <Network size={18} strokeWidth={2.4} />
            </div>
            <div className="landing-brand-labels">
              <strong>ResearchPilot</strong>
              <span>AGENT WORKSPACE</span>
            </div>
          </Link>

          <nav className="landing-nav-links">
            <a href="#overview">Overview</a>
            <a href="#demo">Interactive Preview</a>
            <a href="#workflow">6-Stage Loop</a>
            <a href="#tools">Tool Arsenal</a>
            <a href="#contest">Contest Brief</a>
          </nav>

          <div className="landing-nav-actions">
            <div className="landing-live-status">
              <span className="live-dot" />
              <span>LIVE AGENT</span>
            </div>
            <div className="landing-model-tag">
              <span className="model-dot" />
              <span>GPT-5 mini</span>
            </div>
            <Link href="/app" className="landing-cta-btn primary">
              <span>Launch Console</span>
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section id="overview" className="landing-hero">
        <div className="hero-bg-media" aria-hidden="true">
          <img
            src="/research-hero-bg.jpg"
            alt=""
            className="hero-bg-img"
            loading="eager"
            fetchPriority="high"
          />
          <div className="hero-bg-overlay" />
        </div>
        <div className="hero-container">
          {/* Eyebrow Badge */}
          <div className="landing-eyebrow">
            <span className="eyebrow-icon">
              <Sparkles size={12} />
            </span>
            <span>AUTONOMOUS DECISION INTELLIGENCE · TECHVRUK 2026</span>
          </div>

          {/* Marketing Headline */}
          <h1 className="hero-headline">
            Deep Research, <em>with receipts.</em>
          </h1>

          {/* Marketing Subheading */}
          <p className="hero-subhead">
            Turn complex decision goals into audited, multi-source intelligence briefs. ResearchPilot
            autonomously decomposes tasks, crawls the live web, executes deterministic calculations,
            and audits every claim through an independent verification gate before answering.
          </p>

          {/* Primary Marketing CTAs */}
          <div className="hero-cta-group">
            <Link href="/app" className="hero-primary-cta">
              <Sparkles size={16} />
              <span>Launch Agent Console</span>
              <ArrowRight size={16} />
            </Link>
            <a href="#demo" className="hero-secondary-cta">
              <span>Explore Live Preview</span>
              <ChevronRight size={16} />
            </a>
          </div>

          {/* Key Assurance Badges */}
          <div className="hero-trust-strip">
            <div className="trust-item">
              <ShieldCheck size={14} className="trust-icon" />
              <span>Independent Verification Gate</span>
            </div>
            <div className="trust-divider" />
            <div className="trust-item">
              <Globe2 size={14} className="trust-icon" />
              <span>Live DuckDuckGo Crawler</span>
            </div>
            <div className="trust-divider" />
            <div className="trust-item">
              <Calculator size={14} className="trust-icon" />
              <span>Deterministic AST Math (No eval)</span>
            </div>
            <div className="trust-divider" />
            <div className="trust-item">
              <Database size={14} className="trust-icon" />
              <span>Durable SQLite & MySQL Storage</span>
            </div>
          </div>

          {/* Scroll Cue to Next Fold */}
          <a href="#demo" className="hero-scroll-cue">
            <span>Scroll to explore interactive preview</span>
            <ChevronDown size={14} className="bounce-subtle" />
          </a>
        </div>
      </section>

      {/* Interactive Product Preview Showcase (Replaces raw question box) */}
      <section id="demo" className="landing-preview-section">
        <div className="preview-container">
          {/* Section Header */}
          <div className="preview-header-block">
            <span className="section-eyebrow">
              <Activity size={14} />
              <span>INTERACTIVE PRODUCT PREVIEW</span>
            </span>
            <h2 className="preview-headline">Watch the Autonomous Mind in Action</h2>
            <p className="preview-subtext">
              Select an investigation case below to observe how ResearchPilot decomposes the goal,
              dispatches sandboxed tools, executes verified calculations, and drafts cited reports.
            </p>

            {/* Case Study Tab Switcher */}
            <div className="case-tab-strip">
              {caseStudies.map((cs) => (
                <button
                  key={cs.id}
                  type="button"
                  onClick={() => setSelectedCase(cs)}
                  className={`case-tab-btn ${selectedCase.id === cs.id ? "active" : ""}`}
                >
                  <span className="case-tab-tag">{cs.tag}</span>
                  <span className="case-tab-title">{cs.title}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Split-Screen Interactive Mockup */}
          <div className="mockup-window">
            {/* Window Topbar */}
            <div className="mockup-topbar">
              <div className="mockup-dots">
                <span className="dot dot-red" />
                <span className="dot dot-yellow" />
                <span className="dot dot-green" />
                <span className="mockup-title">ResearchPilot Execution Console · Session #{selectedCase.id}</span>
              </div>
              <div className="mockup-actions">
                <button
                  type="button"
                  onClick={() => handleLaunchCase(selectedCase.goal)}
                  className="mockup-run-btn"
                >
                  <span>Run this goal in Console</span>
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </div>

            {/* Window Body: Split View */}
            <div className="mockup-body-split">
              {/* Left Pane: Agent Cognitive Trace */}
              <div className="mockup-trace-pane">
                <div className="pane-header">
                  <div className="pane-title">
                    <Brain size={14} className="text-violet" />
                    <strong>Agent Execution Pipeline</strong>
                  </div>
                  <span className="pane-status">SSE Live Stream · 0.4s</span>
                </div>

                <div className="trace-goal-card">
                  <span className="trace-label">INVESTIGATION GOAL</span>
                  <p className="trace-goal-text">{selectedCase.goal}</p>
                </div>

                <div className="trace-steps-stack">
                  {/* Step 1: Plan */}
                  <div className="trace-step-item">
                    <div className="step-tag-row">
                      <span className="step-badge-mini planner">01 PLANNER</span>
                      <span className="step-latency">0.4s</span>
                    </div>
                    <ul className="step-bullets">
                      {selectedCase.plan.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>

                  {/* Step 2: Tool Action */}
                  <div className="trace-step-item">
                    <div className="step-tag-row">
                      <span className="step-badge-mini tool">02 TOOL / WEB</span>
                      <span className="step-latency">1.8s</span>
                    </div>
                    <p className="step-single-text">{selectedCase.toolAction}</p>
                  </div>

                  {/* Step 3: Math Engine */}
                  <div className="trace-step-item">
                    <div className="step-tag-row">
                      <span className="step-badge-mini calc">03 CALCULATOR</span>
                      <span className="step-latency">2.6s</span>
                    </div>
                    <div className="step-math-box">
                      <code>{selectedCase.calc}</code>
                    </div>
                  </div>

                  {/* Step 4: Verification Gate */}
                  <div className="trace-step-item highlight-verify">
                    <div className="step-tag-row">
                      <span className="step-badge-mini verify">04 VERIFIER GATE</span>
                      <span className="step-latency">3.4s</span>
                    </div>
                    <p className="step-verify-text">
                      <CheckCircle2 size={13} className="text-emerald" />
                      <span>{selectedCase.verification}</span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Right Pane: Verified Synthesis Brief */}
              <div className="mockup-report-pane">
                <div className="pane-header">
                  <div className="pane-title">
                    <FileText size={14} className="text-emerald" />
                    <strong>Evidence-Grounded Synthesis</strong>
                  </div>
                  <span className="pane-verified-pill">
                    <Check size={11} />
                    <span>Audited with Receipts</span>
                  </span>
                </div>

                {/* Scorecards */}
                <div className="report-metric-row">
                  <div className="report-metric-box">
                    <small>PROXIMATE METRIC</small>
                    <strong>{selectedCase.metrics.cost}</strong>
                  </div>
                  <div className="report-metric-box">
                    <small>PRIMARY SOURCES</small>
                    <strong>{selectedCase.metrics.sources} Verified</strong>
                  </div>
                  <div className="report-metric-box">
                    <small>EXECUTION TIME</small>
                    <strong>{selectedCase.metrics.time}</strong>
                  </div>
                  <div className="report-metric-box">
                    <small>GROUNDING CONFIDENCE</small>
                    <strong className="text-confidence">{selectedCase.metrics.confidence}</strong>
                  </div>
                </div>

                {/* Report Content */}
                <div className="report-doc-preview">
                  <h3>{selectedCase.synthesisTitle}</h3>
                  <div className="report-meta-tag">Generated by ResearchPilot Autonomous Loop · Zero Hallucinations</div>

                  <h4>1. Executive Summary & Verified Findings</h4>
                  <p>
                    {selectedCase.synthesisSummary}{" "}
                    <span className="citation-mark">[S1]</span>{" "}
                    Primary data corroborated across independent regulatory and institutional benchmarks.
                  </p>

                  <h4>2. Deterministic Arithmetic Computation</h4>
                  <p>
                    Financial and capacity projections evaluated via AST calculator with zero LLM rounding error:{" "}
                    <span className="citation-mark">[S2]</span>
                  </p>
                  <div className="report-calc-highlight">
                    <code>{selectedCase.calc}</code>
                  </div>

                  <h4>3. Primary Source Receipts</h4>
                  <div className="report-source-links">
                    <div className="source-link-item">
                      <span className="source-badge">S1</span>
                      <span className="source-title">Institutional Benchmark Report & Expenditure Filing</span>
                    </div>
                    <div className="source-link-item">
                      <span className="source-badge">S2</span>
                      <span className="source-title">National Labor & Commercial Cleantech Rate Schedule</span>
                    </div>
                  </div>
                </div>

                {/* Bottom CTA to launch in workspace */}
                <div className="report-footer-cta">
                  <button
                    type="button"
                    onClick={() => handleLaunchCase(selectedCase.goal)}
                    className="report-open-full-btn"
                  >
                    <span>Launch this research in workspace console</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3 Value Pillars Strip */}
      <section className="landing-pillars-section">
        <div className="pillars-container">
          <div className="pillar-card">
            <div className="pillar-icon-box">
              <Brain size={22} />
            </div>
            <h3>Autonomous Multi-Step Reasoning</h3>
            <p>
              Standard chatbots answer in a single ungrounded pass. ResearchPilot constructs typed,
              step-by-step plans, inspecting intermediate tool outputs before deciding next actions.
            </p>
          </div>

          <div className="pillar-card">
            <div className="pillar-icon-box">
              <ShieldCheck size={22} />
            </div>
            <h3>Independent Verification Barrier</h3>
            <p>
              Every claim must trace to a verified source URL [S1]. An isolated verifier pass checks
              for hallucinations, rejecting ungrounded statements before synthesis is finalized.
            </p>
          </div>

          <div className="pillar-card">
            <div className="pillar-icon-box">
              <Calculator size={22} />
            </div>
            <h3>AST Deterministic Calculations</h3>
            <p>
              LLMs notoriously blunder arithmetic. ResearchPilot extracts formulas and executes them
              inside a sandboxed mathematical AST evaluator with zero shell or eval risks.
            </p>
          </div>
        </div>
      </section>

      {/* Agent Workflow Architecture Section */}
      <section id="workflow" className="landing-section">
        <div className="section-container">
          <div className="section-eyebrow">
            <Layers size={14} />
            <span>AGENTIC EXECUTION PATTERN</span>
          </div>
          <h2 className="section-title">
            The 6-Stage Autonomous Loop
          </h2>
          <p className="section-lead">
            ResearchPilot is architected around a continuous, self-correcting cognitive loop:
            <strong> Plan &rarr; Act &rarr; Observe &rarr; Re-plan &rarr; Verify &rarr; Synthesize</strong>.
          </p>

          <div className="workflow-grid">
            {agentWorkflowSteps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <div
                  key={idx}
                  className={`workflow-card card-${step.color} ${activeStep === idx ? "active" : ""}`}
                  onMouseEnter={() => setActiveStep(idx)}
                >
                  <div className="card-top">
                    <span className="step-num">{step.num}</span>
                    <span className={`step-badge badge-${step.color}`}>{step.badge}</span>
                  </div>
                  <div className="card-icon-wrap">
                    <Icon size={20} />
                  </div>
                  <h3 className="card-title">{step.title}</h3>
                  <p className="card-desc">{step.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Tool Arsenal Section */}
      <section id="tools" className="landing-section alt-bg">
        <div className="section-container">
          <div className="section-eyebrow">
            <Terminal size={14} />
            <span>SANDBOXED TOOL ARSENAL</span>
          </div>
          <h2 className="section-title">
            Empirical Tools, Zero Code Execution Risk
          </h2>
          <p className="section-lead">
            The agent never executes arbitrary generated code. Tools are bounded, audited, and strictly sandboxed.
          </p>

          <div className="tools-grid">
            {toolArsenal.map((tool, idx) => {
              const Icon = tool.icon;
              return (
                <div key={idx} className="tool-card">
                  <div className="tool-icon-box">
                    <Icon size={22} />
                  </div>
                  <div className="tool-tag">{tool.tag}</div>
                  <h3 className="tool-name">{tool.title}</h3>
                  <p className="tool-desc">{tool.desc}</p>
                  <div className="tool-footer">
                    <CheckCircle2 size={13} />
                    <span>{tool.detail}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Comparison: Why Agentic vs Traditional */}
      <section id="why-agentic" className="landing-section">
        <div className="section-container">
          <div className="section-eyebrow">
            <Zap size={14} />
            <span>AGENTIC VS ONE-SHOT</span>
          </div>
          <h2 className="section-title">
            Why ResearchPilot is Truly Agentic
          </h2>
          <p className="section-lead">
            See how an inspectable agentic workflow eliminates the flaws of black-box LLM systems.
          </p>

          <div className="comparison-table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>Evaluation Dimension</th>
                  <th>Standard LLM Chatbot</th>
                  <th>Naive ReAct Loop</th>
                  <th className="highlight-col">ResearchPilot Agent</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Workflow Architecture</strong></td>
                  <td>1-shot prompt &rarr; response</td>
                  <td>Linear thought &rarr; action</td>
                  <td className="highlight-col"><strong>Structured Planner &rarr; Stateful Actor &rarr; Verifier</strong></td>
                </tr>
                <tr>
                  <td><strong>Web Search & Citations</strong></td>
                  <td>Hallucinated URLs & training cutoff</td>
                  <td>Ad-hoc search, unverified links</td>
                  <td className="highlight-col"><strong>Real DuckDuckGo crawler, verified [S1] IDs</strong></td>
                </tr>
                <tr>
                  <td><strong>Handling Failure & Gaps</strong></td>
                  <td>Fabricates answers when data is missing</td>
                  <td>Loops infinitely or crashes</td>
                  <td className="highlight-col"><strong>Dynamic Re-planning & adaptive subtasking</strong></td>
                </tr>
                <tr>
                  <td><strong>Mathematical Calculations</strong></td>
                  <td>Stochastic arithmetic errors</td>
                  <td>Raw eval (arbitrary code vulnerability)</td>
                  <td className="highlight-col"><strong>Deterministic AST Math Engine (no eval)</strong></td>
                </tr>
                <tr>
                  <td><strong>Verification & Auditability</strong></td>
                  <td>Zero audit trail; black-box answer</td>
                  <td>No verification gate before reply</td>
                  <td className="highlight-col"><strong>Independent verifier pass + full SSE trace</strong></td>
                </tr>
                <tr>
                  <td><strong>Persistence & History</strong></td>
                  <td>Browser localStorage or lost</td>
                  <td>Ephemeral in-memory process</td>
                  <td className="highlight-col"><strong>Local SQLite & MySQL Drizzle durable snapshots</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Contest Alignment Showcase */}
      <section id="contest" className="landing-section contest-section">
        <div className="section-container">
          <div className="contest-box">
            <div className="contest-badge">
              <FlaskConical size={15} />
              <span>TECHVRUK CONTEST COMPLIANCE</span>
            </div>
            <h2>Engineered Exactly for the Hackathon Brief</h2>
            <p>
              ResearchPilot satisfies 100% of the contest requirements: autonomous multi-step reasoning,
              structured planning, empirical tool use, stateful persistence, and complete verification transparency.
            </p>

            <div className="contest-grid">
              <div className="contest-pill">
                <Check size={16} className="text-emerald" />
                <span>Text-based task / goal intake</span>
              </div>
              <div className="contest-pill">
                <Check size={16} className="text-emerald" />
                <span>Logical subtask decomposition</span>
              </div>
              <div className="contest-pill">
                <Check size={16} className="text-emerald" />
                <span>Reasoning before every tool action</span>
              </div>
              <div className="contest-pill">
                <Check size={16} className="text-emerald" />
                <span>Live DuckDuckGo & Calculator tools</span>
              </div>
              <div className="contest-pill">
                <Check size={16} className="text-emerald" />
                <span>Stateful session snapshots in SQLite</span>
              </div>
              <div className="contest-pill">
                <Check size={16} className="text-emerald" />
                <span>Grounded, verified decision report</span>
              </div>
            </div>

            <div className="contest-actions">
              <Link href="/app" className="launch-now-btn">
                <span>Open Agent Console</span>
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-left">
            <div className="footer-logo">
              <div className="footer-brand-mark">
                <Network size={14} />
              </div>
              <strong>ResearchPilot</strong>
            </div>
            <p>Autonomous Research & Decision Agent · Built for evidence, not guesswork.</p>
          </div>
          <div className="footer-links">
            <Link href="/app">Agent Console</Link>
            <a href="#demo">Preview</a>
            <a href="#workflow">Workflow</a>
            <a href="#tools">Tools</a>
            <a href="#contest">Techvruk 2026</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
