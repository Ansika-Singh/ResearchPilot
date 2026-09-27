import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { desc, eq } from "drizzle-orm";
import { researchSessions } from "../../drizzle/schema";
import type { ResearchSession } from "@shared/research";
import { getDb } from "../db";

const require = createRequire(import.meta.url);
let sqlite: import("node:sqlite").DatabaseSync | null = null;
let sqlitePath: string | null = null;

function useSQLite(): boolean {
  return process.env.RESEARCH_STORAGE === "sqlite" || (!process.env.RESEARCH_STORAGE && !process.env.DATABASE_URL);
}

function getDbPath(): string {
  if (process.env.RESEARCH_DB_PATH) return resolve(process.env.RESEARCH_DB_PATH);
  if (process.env.VERCEL) return "/tmp/researchpilot.sqlite";
  return resolve("./data/researchpilot.sqlite");
}

function getSQLite(): import("node:sqlite").DatabaseSync {
  const path = getDbPath();
  if (!sqlite || sqlitePath !== path) {
    if (sqlite) sqlite.close();
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    sqlite = new DatabaseSync(path);
    sqlitePath = path;
    sqlite.exec(`CREATE TABLE IF NOT EXISTS research_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      snapshot TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS research_sessions_updated ON research_sessions(updated_at DESC);`);
  }
  return sqlite;
}

export async function saveSession(session: ResearchSession): Promise<void> {
  const snapshot = JSON.stringify(session);
  if (useSQLite()) {
    getSQLite().prepare(`INSERT INTO research_sessions (id, goal, status, created_at, updated_at, snapshot)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET goal=excluded.goal, status=excluded.status,
      updated_at=excluded.updated_at, snapshot=excluded.snapshot`).run(session.id, session.goal, session.status, session.createdAt, session.updatedAt, snapshot);
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Session persistence is unavailable: DATABASE_URL is not configured or the database could not connect.");
  const values = {
    id: session.id,
    goal: session.goal,
    status: session.status,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    snapshot,
  };
  await db.insert(researchSessions).values(values).onDuplicateKeyUpdate({ set: {
    goal: values.goal,
    status: values.status,
    updatedAt: values.updatedAt,
    snapshot: values.snapshot,
  } });
}

function parseSnapshot(snapshot: string): ResearchSession | null {
  try { return JSON.parse(snapshot) as ResearchSession; } catch { return null; }
}

export async function loadSession(id: string): Promise<ResearchSession | null> {
  if (useSQLite()) {
    const row = getSQLite().prepare("SELECT snapshot FROM research_sessions WHERE id = ? LIMIT 1").get(id) as { snapshot?: string } | undefined;
    return row?.snapshot ? parseSnapshot(row.snapshot) : null;
  }
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ snapshot: researchSessions.snapshot }).from(researchSessions).where(eq(researchSessions.id, id)).limit(1);
  return rows[0] ? parseSnapshot(rows[0].snapshot) : null;
}

export async function listSessions(limit = 30): Promise<ResearchSession[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  if (useSQLite()) {
    const rows = getSQLite().prepare("SELECT snapshot FROM research_sessions ORDER BY updated_at DESC LIMIT ?").all(safeLimit) as Array<{ snapshot: string }>;
    return rows.map(row => parseSnapshot(row.snapshot)).filter((row): row is ResearchSession => row !== null);
  }
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ snapshot: researchSessions.snapshot })
    .from(researchSessions)
    .orderBy(desc(researchSessions.updatedAt))
    .limit(safeLimit);
  return rows.map(row => parseSnapshot(row.snapshot)).filter((row): row is ResearchSession => row !== null);
}

export function closeSQLite(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    sqlitePath = null;
  }
}

