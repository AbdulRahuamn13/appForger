import { createServer } from "node:net";
import { execa, type ResultPromise } from "execa";

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each chunk of combined stdout/stderr. */
  onOutput?: (chunk: string) => void;
}

export interface ProcessResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  all: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Every child process AppForge starts (test runners, dev servers, CLIs) goes
 * through here so the global kill switch can stop all of them.
 */
export class ProcessRegistry {
  private readonly live = new Set<ResultPromise>();

  /** Run to completion. Never throws on non-zero exit; check exitCode. */
  async run(file: string, args: string[], options: SpawnOptions): Promise<ProcessResult> {
    const started = Date.now();
    const child = this.spawn(file, args, options);
    const result = await child;
    return {
      exitCode: result.exitCode,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      all: String(result.all ?? ""),
      timedOut: Boolean(result.timedOut),
      durationMs: Date.now() - started,
    };
  }

  /** Start a long-running process (e.g. a dev server). Stop it with stop() or killAll(). */
  spawn(file: string, args: string[], options: SpawnOptions): ResultPromise {
    const child = execa(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, FORCE_COLOR: "0", CI: "1" },
      timeout: options.timeoutMs,
      cancelSignal: options.signal,
      reject: false,
      all: true,
      stdin: "ignore",
      forceKillAfterDelay: 3_000,
      // Own process group so we can kill the whole tree (npm → node → …).
      detached: process.platform !== "win32",
      cleanup: true,
    });
    this.live.add(child);
    if (options.onOutput) {
      child.all?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString()));
    }
    const forget = () => this.live.delete(child);
    child.then(forget, forget);
    return child;
  }

  stop(child: ResultPromise): void {
    killTree(child);
  }

  killAll(): number {
    const count = this.live.size;
    for (const child of this.live) killTree(child);
    return count;
  }

  get size(): number {
    return this.live.size;
  }
}

function killTree(child: ResultPromise): void {
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 3_000).unref();
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  child.kill("SIGTERM");
}

export async function findFreePort(preferred?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1" }, () => {
        const address = server.address();
        const got = typeof address === "object" && address ? address.port : port;
        server.close(() => resolve(got));
      });
    });
  if (preferred) {
    try {
      return await tryPort(preferred);
    } catch {
      // taken; pick any
    }
  }
  return tryPort(0);
}

/** Poll an HTTP URL until it answers (any status) or the timeout passes. */
export async function waitForHttp(url: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}
