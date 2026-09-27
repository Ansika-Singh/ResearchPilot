import { FormEvent, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
const Streamdown = lazy(() => import("streamdown").then(module => ({ default: module.Streamdown })));
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowLeft, ArrowUpRight, BookOpen, Brain, Calculator,
  Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, Copy, FileText,
  FlaskConical, Globe2, LoaderCircle, Menu, Network, PanelLeftClose, Radio, RefreshCw,
  Search, ShieldCheck, Sparkles, Upload, X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import type { AgentEvent, ResearchSession, ResearchSource, TraceStage } from "@shared/research";

type View = "new" | "history" | "sources";
type Upload = { name: string; content: string };

const starterQuestions = [
  "Should our college run a two-day AI/ML workshop for 200 students? Compare costs, staffing and likely demand.",
  "Compare three AI coding platforms by current pricing, features and target users. Cite primary sources.",
  "What evidence supports heat-pump adoption for small commercial buildings? Identify gaps and trade-offs.",
];

const stageMeta: Record<TraceStage, { label: string; icon: typeof Brain; tone: string }> = {
  planner: { label: "PLANNER", icon: Brain, tone: "violet" },
  decision: { label: "DECISION", icon: Network, tone: "blue" },
  tool_execution: { label: "TOOL", icon: Globe2, tone: "mint" },
  observation: { label: "OBSERVATION", icon: Activity, tone: "amber" },
  replan: { label: "RE-PLAN", icon: RefreshCw, tone: "violet" },
  verification: { label: "VERIFICATION", icon: ShieldCheck, tone: "blue" },
  final_report: { label: "FINAL REPORT", icon: FileText, tone: "mint" },
  error: { label: "RECOVERY", icon: AlertTriangle, tone: "red" },
};

function formatDuration(duration?: number) {
  if (duration == null) return "—";
  return duration < 1_000 ? `${duration} ms` : `${(duration / 1_000).toFixed(1)} s`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function TraceCard({ event, index }: { event: AgentEvent; index: number }) {
  const [expanded, setExpanded] = useState(event.stage === "planner" || event.stage === "replan" || event.stage === "verification");
  const meta = stageMeta[event.stage];
  const Icon = meta.icon;
  return (
    <article className={`trace-event tone-${meta.tone}`} style={{ animationDelay: `${Math.min(index * 35, 280)}ms` }}>
      <div className="trace-rail"><span className="trace-node"><Icon size={14} /></span><span className="trace-stem" /></div>
      <div className="trace-card">
        <button className="trace-head" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
          <span className="trace-label">{meta.label}{event.tool ? <span className="trace-tool">/{event.tool.replaceAll("_", " ")}</span> : null}</span>
          <span className="trace-time">{formatTime(event.timestamp)}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="trace-title">{event.title}</div>
        <p className="trace-message">{event.message}</p>
        {expanded && event.details && <pre className="trace-details">{JSON.stringify(event.details, null, 2)}</pre>}
      </div>
    </article>
  );
}

function SourceRow({ source, index }: { source: ResearchSource; index: number }) {
  return (
    <a className="source-row" href={source.url} target="_blank" rel="noreferrer">
      <span className="source-number">S{index + 1}</span>
      <span className="source-body"><strong>{source.title}</strong><small>{source.domain} · {source.relevance ?? "Retrieved by live search"}</small><span>{source.snippet}</span></span>
      <ArrowUpRight size={15} />
    </a>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("new");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localSession, setLocalSession] = useState<ResearchSession | null>(null);
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "connected" | "reconnecting">("idle");
  const [collapsedEvents, setCollapsedEvents] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  const utils = trpc.useUtils();
  const startResearch = trpc.research.start.useMutation();
  const historyQuery = trpc.research.history.useQuery({ limit: 40 }, { refetchInterval: 6_000 });
  const sessionQuery = trpc.research.get.useQuery(
    { id: activeId ?? "00000000-0000-0000-0000-000000000000" },
    { enabled: Boolean(activeId), refetchInterval: localSession?.status === "running" ? 1_100 : false, retry: 1 },
  );
  const remoteSession = sessionQuery.data as ResearchSession | undefined;
  const session = remoteSession ?? localSession;
  const events = useMemo(() => {
    const merged = new Map<number, AgentEvent>();
    (remoteSession?.events ?? []).forEach(event => merged.set(event.id, event));
    liveEvents.forEach(event => merged.set(event.id, event));
    return Array.from(merged.values()).sort((a, b) => a.id - b.id);
  }, [remoteSession?.events, liveEvents]);
  const isRunning = session?.status === "running" || (localSession?.status === "running" && !remoteSession);

  useEffect(() => {
    if (!activeId) return;
    setStreamState("connecting");
    const goalParam = localSession?.goal ? `?goal=${encodeURIComponent(localSession.goal)}` : "";
    const stream = new EventSource(`/api/research/${activeId}/events${goalParam}`);
    stream.onopen = () => setStreamState("connected");
    stream.addEventListener("agent_event", raw => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as AgentEvent;
        setLiveEvents(current => current.some(item => item.id === event.id) ? current : [...current, event].sort((a, b) => a.id - b.id));
        if (event.stage === "final_report") {
          const reportText = (event.details as any)?.report;
          setLocalSession(curr => curr ? {
            ...curr,
            status: "completed",
            ...(reportText ? { report: reportText } : {}),
            verification: (event.details as any)?.verification ? { status: (event.details as any).verification, issues: [], unsupportedClaims: [], missingInformation: [], requiredActions: [] } : curr.verification,
          } : curr);
          window.setTimeout(() => {
            void utils.research.get.invalidate({ id: activeId });
            void utils.research.history.invalidate();
          }, 250);
        } else if (event.stage === "error") {
          setLocalSession(curr => curr ? { ...curr, status: "failed" } : curr);
          window.setTimeout(() => {
            void utils.research.get.invalidate({ id: activeId });
            void utils.research.history.invalidate();
          }, 250);
        }
      } catch (error) {
        console.error("Could not decode ResearchPilot event", error);
      }
    });
    stream.addEventListener("stream_complete", () => setStreamState("idle"));
    stream.addEventListener("stream_error", () => setStreamState("reconnecting"));
    stream.onerror = () => setStreamState(stream.readyState === EventSource.CLOSED ? "idle" : "reconnecting");
    return () => stream.close();
  }, [activeId, utils.research.get, utils.research.history]);

  useEffect(() => {
    if (remoteSession) setLocalSession(remoteSession);
  }, [remoteSession]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryGoal = params.get("goal") || params.get("q");
    if (queryGoal && queryGoal.trim().length > 0) {
      setGoal(queryGoal.trim());
      setView("new");
    }
  }, []);

  async function submitResearch(event: FormEvent) {
    event.preventDefault();
    const cleanGoal = goal.trim();
    if (cleanGoal.length < 12 || startResearch.isPending) return;
    setView("new");
    setLiveEvents([]);
    setLocalSession(null);
    setActiveId(null);
    setCollapsedEvents(false);
    try {
      const run = await startResearch.mutateAsync({
        goal: cleanGoal,
        ...(context.trim() ? { context: context.trim() } : {}),
        ...(upload ? { file: upload } : {}),
      });
      setActiveId(run.id);
      setLocalSession(run as ResearchSession);
      setGoal("");
      setContext("");
      setShowContext(false);
      setUpload(null);
      setStreamState("connecting");
      void historyQuery.refetch();
    } catch (error) {
      console.error(error);
    }
  }

  async function chooseFile(file?: File) {
    if (!file) return;
    const extension = file.name.toLowerCase().split(".").pop();
    if (!extension || !["csv", "json", "txt", "md", "markdown"].includes(extension)) {
      window.alert("Supported research files: CSV, JSON, TXT, and Markdown.");
      return;
    }
    if (file.size > 80_000) {
      window.alert("This prototype accepts text-based files up to 80 KB.");
      return;
    }
    setUpload({ name: file.name, content: await file.text() });
  }

  function openHistory(id: string) {
    setActiveId(id);
    setLiveEvents([]);
    setLocalSession(null);
    setView("new");
    setCollapsedEvents(false);
    setMobileNav(false);
  }

  async function copyReport() {
    if (!session?.report) return;
    await navigator.clipboard.writeText(session.report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  function exportMarkdown() {
    if (!session?.report) return;
    const content = `${session.report}\n\n---\nResearchPilot session: ${session.id}\nVerification: ${session.verification?.status ?? "pending"}\n\n## Sources\n${session.sources.map((source, index) => `\n- [S${index + 1}] [${source.title}](${source.url})`).join("")}`;
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `researchpilot-${session.id.slice(0, 8)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const recentRuns = historyQuery.data ?? [];
  const activeTab = view;
  const currentPlan = session?.plan;
  const phases = [
    { label: "Planning", done: events.some(event => event.stage === "planner"), active: !events.length && isRunning },
    { label: "Research", done: Boolean(currentPlan?.steps.length && currentPlan.steps.every(step => step.status === "completed")), active: Boolean(isRunning && currentPlan?.steps.some(step => step.status !== "completed")) },
    { label: "Re-plan", done: (session?.metrics.replans ?? 0) > 0, active: events.at(-1)?.stage === "replan" },
    { label: "Verify", done: session?.metrics.verificationStatus === "PASS", active: events.at(-1)?.stage === "verification" && isRunning },
    { label: "Report", done: Boolean(session?.report), active: events.at(-1)?.stage === "final_report" },
  ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand-lockup"><div className="brand-mark"><Network size={19} strokeWidth={2.1} /></div><div><strong>ResearchPilot</strong><span>AGENT WORKSPACE</span></div><button className="nav-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
        <Link href="/" className="nav-item"><ArrowLeft size={17} /><span>Product Overview</span></Link>
        <button className={`nav-item ${activeTab === "new" ? "nav-active" : ""}`} onClick={() => { setView("new"); setActiveId(null); setLocalSession(null); setMobileNav(false); }}><Sparkles size={17} /><span>New research</span><kbd>⌘ N</kbd></button>
        <div className="nav-section-label">WORKSPACE</div>
        <button className={`nav-item ${activeTab === "history" ? "nav-active" : ""}`} onClick={() => { setView("history"); setMobileNav(false); }}><Clock3 size={17} /><span>Run history</span><span className="nav-count">{recentRuns.length || "—"}</span></button>
        <button className={`nav-item ${activeTab === "sources" ? "nav-active" : ""}`} onClick={() => { setView("sources"); setMobileNav(false); }}><BookOpen size={17} /><span>Sources</span>{session?.sources.length ? <span className="nav-count">{session.sources.length}</span> : null}</button>
        <div className="sidebar-rule" />
        <div className="nav-section-label">RECENT RUNS</div>
        <div className="recent-list">
          {recentRuns.slice(0, 5).map(item => (
            <button key={item.id} className={`recent-run ${activeId === item.id ? "recent-selected" : ""}`} onClick={() => openHistory(item.id)} title={item.goal}>
              <span className={`run-dot run-${item.status}`} /><span>{item.goal}</span>
            </button>
          ))}
          {!recentRuns.length && <p className="sidebar-empty">Your research runs will appear here.</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="runtime-card"><span className="runtime-indicator" /><span><strong>Agent runtime</strong><small>LLM + live web tools</small></span><span className="runtime-check"><Check size={12} /></span></div>
          <div className="sidebar-foot"><FlaskConical size={13} /> BUILT FOR EVIDENCE, NOT GUESSWORK</div>
        </div>
      </aside>
      {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close menu" />}

      <main className="main-workspace">
        <header className="topbar"><div className="topbar-left"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><Link href="/" className="overview-back-link"><ArrowLeft size={12} /> Overview</Link><span className="breadcrumb">Workspace</span><ChevronRight size={14} /><span className="breadcrumb-current">{view === "new" ? "Research console" : view === "history" ? "Run history" : "Source library"}</span></div><div className="topbar-right"><span className="live-badge"><span /> LIVE AGENT</span><span className="topbar-divider" /><span className="model-label"><span className="model-pulse" /> GPT-5 mini</span></div></header>

        <div className="content-wrap">
          {view === "history" ? (
            <section className="page-section history-page">
              <div className="eyebrow"><Clock3 size={14} /> EXECUTION HISTORY</div><h1>Every run, <em>accounted for.</em></h1><p className="page-intro">Review the actual questions, tools, sources, and verification outcomes from previous runs.</p>
              <div className="history-list">
                {recentRuns.map(item => <button className="history-item" key={item.id} onClick={() => openHistory(item.id)}><span className={`history-status history-${item.status}`}><span /></span><span className="history-main"><strong>{item.goal}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.eventCount} trace events · {item.toolCount} tools · {item.sourceCount} sources</small></span><span className={`verify-pill ${item.verificationStatus === "PASS" ? "verify-pass" : item.verificationStatus === "FAIL" ? "verify-fail" : "verify-pending"}`}>{item.verificationStatus}</span><ChevronRight size={17} /></button>)}
                {!recentRuns.length && <div className="empty-panel"><Clock3 size={24} /><strong>No research runs yet</strong><span>Start with a new question; its execution history will live here.</span><button className="button-secondary" onClick={() => setView("new")}>Start research</button></div>}
              </div>
            </section>
          ) : view === "sources" ? (
            <section className="page-section history-page">
              <div className="eyebrow"><BookOpen size={14} /> SOURCE LIBRARY</div><h1>Evidence, <em>not decoration.</em></h1><p className="page-intro">Sources are captured from real tool results. Open a run below to inspect its source IDs and extracted evidence.</p>
              {session?.sources.length ? <div className="source-list">{session.sources.map((source, index) => <SourceRow key={`${source.url}-${index}`} source={source} index={index} />)}</div> : <div className="empty-panel"><Search size={24} /><strong>No sources in this run</strong><span>Select a completed run, or start a question to collect citations through live search.</span><button className="button-secondary" onClick={() => setView("new")}>New research</button></div>}
            </section>
          ) : (
            <>
              {!session && (
                <section className="hero-block">
                  <div className="eyebrow"><span className="eyebrow-icon"><Sparkles size={13} /></span> AUTONOMOUS RESEARCH, MADE VISIBLE</div>
                  <h1>Research, <em>with receipts.</em></h1>
                  <p className="hero-copy">Ask a question. Watch the agent plan, search, evaluate what it finds, re-plan when the evidence shifts, then verify before it answers.</p>
                  <div className="capability-line"><span><Brain size={14} /> Adaptive planning</span><span><Globe2 size={14} /> Live web tools</span><span><ShieldCheck size={14} /> Evidence verification</span></div>
                  <form className="research-composer" onSubmit={submitResearch}>
                    <label className="sr-only" htmlFor="research-goal">Research question</label>
                    <textarea id="research-goal" value={goal} onChange={event => setGoal(event.target.value)} placeholder="What should ResearchPilot investigate?" rows={4} maxLength={3000} />
                    {upload && <div className="file-chip"><FileText size={14} /><span>{upload.name}</span><button type="button" onClick={() => setUpload(null)} aria-label="Remove file"><X size={14} /></button></div>}
                    {showContext && <textarea className="context-input" value={context} onChange={event => setContext(event.target.value)} placeholder="Add constraints or context the agent should preserve…" rows={2} maxLength={1500} />}
                    {startResearch.error && <div className="form-error"><AlertTriangle size={15} />{startResearch.error.message}</div>}
                    <div className="composer-footer"><div className="composer-actions"><label className="attach-button" title="Attach CSV, JSON, TXT, or Markdown"><Upload size={15} /><span>Attach file</span><input type="file" accept=".csv,.json,.txt,.md,.markdown,text/*" onChange={event => { void chooseFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label><button type="button" className={`context-toggle ${showContext ? "context-on" : ""}`} onClick={() => setShowContext(value => !value)}><PanelLeftClose size={14} />{showContext ? "Hide constraints" : "Add constraints"}</button></div><span className="character-count">{goal.length}/3000</span><button className="start-button" type="submit" disabled={goal.trim().length < 12 || startResearch.isPending}>{startResearch.isPending ? <><LoaderCircle size={16} className="spin" /> Starting…</> : <>Start research <ArrowDownRight size={16} /></>}</button></div>
                  </form>
                  <div className="examples"><span className="examples-label">TRY A QUESTION</span>{starterQuestions.map((example, index) => <button key={example} onClick={() => setGoal(example)}><span>0{index + 1}</span>{example}</button>)}</div>
                </section>
              )}

              {session && (
                <section className="run-workspace">
                  <div className="run-heading"><div><div className="eyebrow"><span className={`status-pip ${isRunning ? "status-running" : session.status === "completed" ? "status-complete" : "status-failed"}`} />{isRunning ? "AGENT EXECUTING" : session.status === "completed" ? "RESEARCH RUN COMPLETE" : "RUN INTERRUPTED"}</div><h1>{session.goal}</h1><div className="run-meta"><span><Clock3 size={13} /> {new Date(session.createdAt).toLocaleString()}</span><span className="stream-status"><Radio size={13} className={streamState === "connected" ? "radio-live" : ""} /> {streamState === "connected" ? "Live trace connected" : streamState === "reconnecting" ? "Reconnecting to trace" : "Connecting to trace"}</span></div></div><button className="button-secondary new-run-button" onClick={() => { setActiveId(null); setLocalSession(null); setLiveEvents([]); setView("new"); }}>+ New run</button></div>

                  <div className="phase-strip">{phases.map((phase, index) => <div key={phase.label} className={`phase-step ${phase.done ? "phase-done" : phase.active ? "phase-active" : ""}`}><span className="phase-icon">{phase.done ? <Check size={13} /> : phase.active ? <LoaderCircle size={13} className="spin" /> : <Circle size={11} />}</span><span>{phase.label}</span>{index < phases.length - 1 && <span className="phase-line" />}</div>)}</div>

                  <div className="metrics-grid"><Metric label="Plan steps" value={`${session.plan?.steps.filter(step => step.status === "completed").length ?? 0}/${session.plan?.steps.length ?? "—"}`} icon={<Network size={15} />} /><Metric label="Tool calls" value={String(session.metrics.toolCalls)} icon={<Globe2 size={15} />} /><Metric label="Sources" value={String(session.sources.length)} icon={<BookOpen size={15} />} /><Metric label="Re-plans" value={String(session.metrics.replans)} icon={<RefreshCw size={15} />} /><Metric label="Verification" value={session.metrics.verificationStatus} icon={<ShieldCheck size={15} />} accent={session.metrics.verificationStatus === "PASS" ? "green" : session.metrics.verificationStatus === "FAIL" ? "red" : ""} /></div>

                  <div className="run-grid"><section className="trace-panel"><div className="panel-heading"><div><span className="panel-icon"><Activity size={16} /></span><div><h2>Live agent trace</h2><p>Events emitted by the executing backend · {events.length} total</p></div></div><button className="subtle-button" onClick={() => setCollapsedEvents(value => !value)}>{collapsedEvents ? "Expand" : "Collapse"}{collapsedEvents ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></div>
                    {!collapsedEvents && <div className="trace-list">{events.map((event, index) => <TraceCard key={event.id} event={event} index={index} />)}{isRunning && <div className="trace-wait"><span className="thinking-dots"><i /><i /><i /></span><span>{events.length ? "The agent is evaluating its next move…" : "Planner is starting the research run…"}</span></div>}{!isRunning && !events.length && <div className="empty-trace">No trace events were received. Check the connection and reopen this run.</div>}</div>}
                  </section>

                    <aside className="evidence-column"><div className="side-panel plan-panel"><div className="side-panel-heading"><span className="panel-icon violet-icon"><Network size={15} /></span><div><h2>Working plan</h2><p>{session.plan ? `${session.plan.steps.length} subgoals · adapts to findings` : "Waiting for planner"}</p></div></div>{session.plan ? <><p className="plan-objective">{session.plan.objective}</p><div className="plan-steps">{session.plan.steps.map((step, index) => <div key={step.id} className={`plan-step plan-${step.status}`}><span className="plan-step-state">{step.status === "completed" ? <Check size={12} /> : step.status === "in_progress" ? <LoaderCircle size={12} className="spin" /> : String(index + 1).padStart(2, "0")}</span><span><strong>{step.title}</strong><small>{step.expectedInformation}</small></span></div>)}</div></> : <div className="plan-skeleton"><i /><i /><i /></div>}</div>

                    <div className="side-panel sources-panel"><div className="side-panel-heading"><span className="panel-icon mint-icon"><BookOpen size={15} /></span><div><h2>Evidence collected</h2><p>{session.sources.length} real source{session.sources.length === 1 ? "" : "s"} · {session.evidence.length} claims</p></div><button className="view-all" onClick={() => setView("sources")}>View</button></div>{session.sources.length ? <div className="mini-source-list">{session.sources.slice(0, 4).map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" className="mini-source" key={source.id}><span>S{index + 1}</span><strong>{source.title}</strong><ArrowUpRight size={12} /></a>)}</div> : <p className="empty-evidence">Sources appear here after actual web searches return evidence.</p>}</div>

                    <div className="integrity-note"><ShieldCheck size={15} /><span><strong>Evidence integrity</strong><small>No preloaded results. Citations are created only by tools used in this run.</small></span></div></aside></div>

                  {session.verification?.status === "FAIL" && <div className="verification-alert"><AlertTriangle size={17} /><div><strong>Verification found gaps</strong><span>{session.verification.issues.join(" ")}</span></div></div>}
                  {session.status === "failed" && <div className="verification-alert"><AlertTriangle size={17} /><div><strong>Run stopped safely</strong><span>{session.errors.join(" ") || "The agent reported an unexpected error."}</span></div></div>}

                  {session.report && <section className="report-panel"><div className="report-heading"><div><div className="eyebrow"><CheckCircle2 size={14} /> VERIFIED SYNTHESIS</div><h2>Research report</h2><p>Generated from this session's evidence and verification result.</p></div><div className="report-actions"><button className="button-secondary" onClick={() => void copyReport()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button><button className="button-secondary" onClick={exportMarkdown}><FileText size={14} />Export Markdown</button></div></div><div className="report-content"><Suspense fallback={<p>Formatting report…</p>}><Streamdown>{session.report}</Streamdown></Suspense></div>{session.sources.length > 0 && <div className="report-source-footer"><strong>Sources used in this run</strong>{session.sources.map((source, index) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">[S{index + 1}] {source.title} <ArrowUpRight size={12} /></a>)}</div>}</section>}

                  <div className="run-footnote"><span>SESSION {session.id.slice(0, 8).toUpperCase()}</span><span>{session.metrics.llmCalls} model calls · {session.metrics.errors} recoverable issues · {formatDuration(session.metrics.durationMs)}</span></div>
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value, icon, accent = "" }: { label: string; value: string; icon: React.ReactNode; accent?: string }) {
  return <div className={`metric-card ${accent ? `metric-${accent}` : ""}`}><span className="metric-icon">{icon}</span><span className="metric-value">{value}</span><span className="metric-label">{label}</span></div>;
}
