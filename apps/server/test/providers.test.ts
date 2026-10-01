import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEventPayload, ServerMessage } from "@appforge/core";
import { MemorySecretStore, ProviderRegistry, ScriptedAdapter } from "@appforge/providers";
import { buildApp } from "../src/app.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "appforge-srvp-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("providers API", () => {
  it("reports auth status, stores keys without echoing them, and streams a playground prompt", async () => {
    const secrets = new MemorySecretStore();
    const scripted = new ScriptedAdapter(() => ({ text: "pong", files: { "out.txt": "x" } }), "scripted", "Scripted");
    const { app, ctx } = await buildApp({ dataDir: tmp, dbFile: ":memory:", secrets, providers: new ProviderRegistry([scripted]) });

    const providers = (await app.inject({ method: "GET", url: "/api/providers" })).json<{ id: string; status: { ok: boolean } }[]>();
    expect(providers).toEqual([expect.objectContaining({ id: "scripted", status: expect.objectContaining({ ok: true }) })]);

    const put = await app.inject({ method: "PUT", url: "/api/secrets/anthropic-api-key", payload: { value: "sk-ant-secret" } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("sk-ant-secret");
    const list = await app.inject({ method: "GET", url: "/api/secrets" });
    expect(list.body).not.toContain("sk-ant-secret");
    expect(list.json<Record<string, { present: boolean }>>()["anthropic-api-key"]?.present).toBe(true);
    expect((await app.inject({ method: "PUT", url: "/api/secrets/nope", payload: { value: "x" } })).statusCode).toBe(404);

    const events: AgentEventPayload[] = [];
    const done = new Promise<void>((resolve) => {
      ctx.hub.subscribe((msg: ServerMessage) => {
        if (msg.kind !== "playground-event") return;
        events.push(msg.payload);
        if (msg.payload.type === "session-end") resolve();
      });
    });
    const res = await app.inject({ method: "POST", url: "/api/playground", payload: { provider: "scripted", prompt: "ping" } });
    expect(res.statusCode, res.body).toBe(200);
    await done;
    expect(events.map((e) => e.type)).toContain("text");
    expect(events.at(-1)).toMatchObject({ type: "session-end", status: "completed", result: "pong" });
    await app.close();
  });
});
