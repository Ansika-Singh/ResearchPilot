import "dotenv/config";
import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { getResearchSession, isResearchActive, subscribeToResearch } from "../research/runtime";

export function createExpressApp(): Express {
  const app = express();
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  app.get("/api/research/:id/events", async (req, res) => {
    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      res.status(400).json({ error: "Invalid research session id." });
      return;
    }
    const after = Number(req.get("Last-Event-ID") ?? req.query.after ?? 0);
    let lastSent = Number.isFinite(after) ? after : 0;
    const buffered: import("@shared/research").AgentEvent[] = [];
    let ready = false;
    let closed = false;
    const send = (event: import("@shared/research").AgentEvent) => {
      if (closed || event.id <= lastSent) return;
      lastSent = event.id;
      res.write(`id: ${event.id}\nevent: agent_event\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribeToResearch(sessionId, event => {
      if (ready) send(event);
      else buffered.push(event);
    });
    res.status(200);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 1500\n\n");
    try {
      const session = await getResearchSession(sessionId);
      if (!session) {
        res.write(`event: stream_error\ndata: ${JSON.stringify({ error: "Research session not found." })}\n\n`);
        closed = true;
        unsubscribe();
        res.end();
        return;
      }
      session.events.forEach(send);
      ready = true;
      buffered.sort((a, b) => a.id - b.id).forEach(send);
      if (!isResearchActive(sessionId)) {
        res.write("event: stream_complete\ndata: {}\n\n");
        closed = true;
        unsubscribe();
        res.end();
        return;
      }
      const heartbeat = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15_000);
      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch {
      closed = true;
      unsubscribe();
      res.end();
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  return app;
}

export const app = createExpressApp();
export default app;
