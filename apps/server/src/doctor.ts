import { execa } from "execa";
import type { ProviderRegistry, SecretStore } from "@appforge/providers";
import { StorageManager } from "./storage.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Not required for every project (e.g. .NET only for ASP.NET stacks). */
  optional?: boolean;
  hint?: string;
}

async function version(file: string, args: string[] = ["--version"]): Promise<string | undefined> {
  try {
    const res = await execa(file, args, { reject: false, timeout: 15_000, stdin: "ignore", all: true });
    if (res.exitCode !== 0) return undefined;
    return String(res.all ?? "").split("\n").find((l) => l.trim())?.trim();
  } catch {
    return undefined;
  }
}

/** Environment check: everything AppForge and the generated stacks need, in one place. */
export async function runDoctor(providers: ProviderRegistry, secrets: SecretStore, storage: StorageManager): Promise<DoctorCheck[]> {
  const [git, npm, pnpm, python, dotnet] = await Promise.all([version("git"), version("npm"), version("pnpm"), version("python3"), version("dotnet")]);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks: DoctorCheck[] = [
    { name: "Node.js", ok: nodeMajor >= 22, detail: `v${process.versions.node}`, ...(nodeMajor >= 22 ? {} : { hint: "Install Node.js 22 or newer" }) },
    { name: "git", ok: Boolean(git), detail: git ?? "not found", ...(git ? {} : { hint: "Install git" }) },
    { name: "npm", ok: Boolean(npm), detail: npm ? `v${npm}` : "not found" },
    { name: "pnpm", ok: Boolean(pnpm), optional: true, detail: pnpm ? `v${pnpm}` : "not found" },
    { name: "Python 3", ok: Boolean(python), optional: true, detail: python ?? "not found (needed for FastAPI stacks and pytest)" },
    { name: ".NET SDK", ok: Boolean(dotnet), optional: true, detail: dotnet ? `v${dotnet}` : "not found (needed for ASP.NET Core stacks and xUnit)" },
  ];
  const statuses = await providers.statuses();
  for (const p of providers.list()) {
    const st = statuses[p.id];
    checks.push({ name: p.label, ok: Boolean(st?.ok), optional: p.authKind === "api-key" || p.id === "demo", detail: st?.detail ?? "unknown", ...(st?.hint ? { hint: st.hint } : {}) });
  }
  const keychain = await secrets.status("anthropic-api-key");
  checks.push({
    name: "OS keychain",
    ok: !keychain.keychainError,
    optional: true,
    detail: keychain.keychainError ? `unavailable: ${keychain.keychainError}` : "available",
    ...(keychain.keychainError ? { hint: "API keys can come from environment variables instead" } : {}),
  });
  try {
    await StorageManager.probe(storage.store);
    checks.push({ name: "Storage", ok: true, detail: `${storage.getSettings().mode}: ${storage.store.describe()}` });
  } catch (err) {
    checks.push({ name: "Storage", ok: false, detail: (err as Error).message, hint: "Check Settings → Storage" });
  }
  return checks;
}
