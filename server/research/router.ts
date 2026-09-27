import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getResearchHistory, getResearchSession, startResearchRun } from "./runtime";

const uploadSchema = z.object({
  name: z.string().min(1).max(180),
  content: z.string().max(80_000),
}).optional();

export const researchRouter = router({
  start: publicProcedure.input(z.object({
    goal: z.string().trim().min(12, "Please provide a research question with enough detail.").max(3_000),
    context: z.string().max(1_500).optional(),
    file: uploadSchema,
  })).mutation(async ({ input }) => {
    return startResearchRun(input.goal, { context: input.context, file: input.file });
  }),
  get: publicProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const session = await getResearchSession(input.id);
    if (!session) throw new Error("Research session not found.");
    return session;
  }),
  history: publicProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional()).query(async ({ input }) => {
    return (await getResearchHistory(input?.limit ?? 30)).map(session => ({
      id: session.id, goal: session.goal, status: session.status, createdAt: session.createdAt,
      updatedAt: session.updatedAt, eventCount: session.events.length, sourceCount: session.sources.length,
      toolCount: session.toolCalls.length, verificationStatus: session.metrics.verificationStatus,
      durationMs: session.metrics.durationMs,
    }));
  }),
  sources: publicProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const session = await getResearchSession(input.id);
    if (!session) throw new Error("Research session not found.");
    return session.sources;
  }),
});
