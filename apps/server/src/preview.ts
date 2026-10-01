import type { PreviewState, Project } from "@appforge/core";
import { tail } from "@appforge/core";
import type { ProjectTesting, RunningApp } from "@appforge/testing";
import type { Hub } from "./hub.ts";

interface Running {
  state: PreviewState;
  app?: RunningApp;
  abort: AbortController;
}

/**
 * Live preview: run the project's backend + frontend dev servers from the
 * UI and open the app, without a terminal. Uses the same launcher as E2E.
 */
export class PreviewService {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly testing: ProjectTesting,
    private readonly hub: Hub,
  ) {}

  state(projectId: string): PreviewState {
    return this.running.get(projectId)?.state ?? { status: "stopped", output: "" };
  }

  private publish(projectId: string, r: Running): void {
    this.hub.broadcast({ kind: "preview-updated", projectId, preview: r.state });
  }

  async start(project: Project): Promise<PreviewState> {
    const existing = this.running.get(project.id);
    if (existing && (existing.state.status === "running" || existing.state.status === "starting")) return existing.state;
    const r: Running = { state: { status: "starting", output: "" }, abort: new AbortController() };
    this.running.set(project.id, r);
    this.publish(project.id, r);
    let lastPublish = 0;
    const append = (line: string) => {
      r.state = { ...r.state, output: tail(r.state.output + line, 20_000) };
      if (Date.now() - lastPublish > 500) {
        lastPublish = Date.now();
        this.publish(project.id, r);
      }
    };
    void this.testing
      .startApp(project, {
        project,
        signal: r.abort.signal,
        log: (m) => append(`▸ ${m}\n`),
        onOutput: (name, chunk) => append(chunk.split("\n").map((l) => (l ? `[${name}] ${l}` : l)).join("\n")),
      })
      .then(
        (app) => {
          if (r.abort.signal.aborted) return void app.stop();
          r.app = app;
          r.state = { ...r.state, status: "running", frontendUrl: app.frontendUrl, backendUrl: app.backendUrl };
          this.publish(project.id, r);
        },
        (err: Error) => {
          r.state = { ...r.state, status: "failed", error: err.message.split("\n")[0] ?? err.message };
          this.publish(project.id, r);
        },
      );
    return r.state;
  }

  async stop(projectId: string): Promise<PreviewState> {
    const r = this.running.get(projectId);
    if (!r) return this.state(projectId);
    r.abort.abort();
    await r.app?.stop();
    r.state = { status: "stopped", output: r.state.output };
    this.publish(projectId, r);
    this.running.delete(projectId);
    return r.state;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}
