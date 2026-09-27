import type { AgentEvent, ResearchSession } from "@shared/research";
import { createResearchSession, runResearch } from "./engine";
import { listSessions, loadSession, saveSession } from "./store";

type Listener = (event: AgentEvent) => void;
const sessions = new Map<string, ResearchSession>();
const active = new Set<string>();
const listeners = new Map<string, Set<Listener>>();

export async function startResearchRun(goal: string, options: { context?: string; file?: { name: string; content: string } } = {}): Promise<ResearchSession> {
  const session = createResearchSession(goal, options.context);
  sessions.set(session.id, session);
  active.add(session.id);
  try { await saveSession(session); } catch (error) {
    const message = error instanceof Error ? error.message : "Session storage unavailable.";
    session.errors.push(message);
  }
  void runResearch(session, event => {
    sessions.set(session.id, session);
    Array.from(listeners.get(session.id) ?? []).forEach(listener => listener(event));
  }, options).then(result => {
    sessions.set(result.id, result);
  }).finally(() => {
    active.delete(session.id);
  });
  return session;
}

export async function getResearchSession(id: string): Promise<ResearchSession | null> {
  const inMemory = sessions.get(id);
  if (inMemory) return inMemory;
  const stored = await loadSession(id);
  if (stored?.status === "running") return markInterrupted(stored);
  return stored;
}

export async function getResearchHistory(limit = 30): Promise<ResearchSession[]> {
  const stored = await listSessions(limit);
  for (const session of stored) {
    if (session.status === "running" && !sessions.has(session.id)) await markInterrupted(session);
  }
  const merged = new Map(stored.map(session => [session.id, session]));
  Array.from(sessions.values()).forEach(session => merged.set(session.id, session));
  return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export function isResearchActive(id: string): boolean {
  return active.has(id);
}

export function subscribeToResearch(id: string, listener: Listener): () => void {
  const set = listeners.get(id) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
}

async function markInterrupted(session: ResearchSession): Promise<ResearchSession> {
  if (session.status !== "running") return session;
  const message = "The server process restarted before this run finished. Start a new run to resume the research with a fresh live session.";
  session.status = "failed";
  session.updatedAt = Date.now();
  session.metrics.completedAt = session.updatedAt;
  session.metrics.durationMs = session.updatedAt - session.metrics.startedAt;
  session.metrics.errors += 1;
  session.errors.push(message);
  session.events.push({
    id: session.events.length + 1,
    timestamp: session.updatedAt,
    stage: "error",
    title: "Run interrupted by server restart",
    message,
    details: { recoverable: true },
  });
  sessions.set(session.id, session);
  try { await saveSession(session); } catch { /* Preserve the visible in-memory recovery if storage is unavailable. */ }
  return session;
}
