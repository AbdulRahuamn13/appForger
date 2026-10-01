import type { FastifyInstance } from "fastify";
import type { ExecutionMode, StoryPlan } from "@appforge/core";
import type { AppContext } from "../context.ts";
import { StoryError, type StoryInput } from "../stories.ts";

export function storyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { stories } = ctx;
  const handle = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => T | Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StoryError || (err instanceof Error && !(err instanceof TypeError))) return reply.code(400).send({ error: err.message });
      throw err;
    }
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/stories", async (req) => ctx.store.listStories(req.params.id));

  app.post<{ Params: { id: string }; Body: StoryInput }>("/api/projects/:id/stories", async (req, reply) =>
    handle(reply, () => reply.code(201).send(stories.create(req.params.id, req.body ?? {}))),
  );

  app.post<{ Params: { id: string }; Body: { ids: string[] } }>("/api/projects/:id/stories/reorder", async (req, reply) =>
    handle(reply, () => stories.reorder(req.params.id, req.body?.ids ?? [])),
  );

  app.get<{ Params: { id: string } }>("/api/stories/:id", async (req, reply) =>
    handle(reply, () => {
      const story = stories.get(req.params.id);
      return { story, runs: ctx.store.listRunsForStory(story.id) };
    }),
  );

  app.patch<{ Params: { id: string }; Body: StoryInput & { plan?: StoryPlan } }>("/api/stories/:id", async (req, reply) =>
    handle(reply, () => stories.update(req.params.id, req.body ?? {})),
  );

  app.delete<{ Params: { id: string } }>("/api/stories/:id", async (req, reply) =>
    handle(reply, () => {
      stories.delete(req.params.id);
      return { ok: true };
    }),
  );

  /** Plan (or re-plan with feedback). Nothing is built until you approve. */
  app.post<{ Params: { id: string }; Body: { feedback?: string } }>("/api/stories/:id/plan", async (req, reply) =>
    handle(reply, () => stories.plan(req.params.id, req.body?.feedback)),
  );

  /** Approve the plan and choose how to build it. */
  app.post<{ Params: { id: string }; Body: { mode: ExecutionMode; repo?: string } }>("/api/stories/:id/approve", async (req, reply) =>
    handle(reply, () => stories.approve(req.params.id, req.body?.mode, req.body?.repo)),
  );

  app.post<{ Params: { id: string } }>("/api/stories/:id/undo", async (req, reply) => handle(reply, () => stories.undo(req.params.id)));
}
