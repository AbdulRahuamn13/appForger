import { describe, expect, it } from "vitest";
import {
  coderPrompt,
  getStack,
  locatePart,
  reposForShape,
  reviewerPrompt,
  roleAccess,
  STACK_TEMPLATES,
  starterFiles,
  systemPrompt,
} from "../src/index.ts";

describe("stack templates", () => {
  it("produce parseable package manifests and stay inside backend/ and frontend/", () => {
    for (const stack of STACK_TEMPLATES) {
      const files = starterFiles(stack, { projectName: "Todo {App}" });
      for (const [file, content] of Object.entries(files)) {
        expect(file.startsWith("backend/") || file.startsWith("frontend/")).toBe(true);
        if (file.endsWith(".json")) expect(() => JSON.parse(content)).not.toThrow();
      }
    }
  });

  it("escapes the project name inside JSX", () => {
    const files = starterFiles(getStack("node-react"), { projectName: "A <b> {x}" });
    expect(files["frontend/src/App.tsx"]).toContain("A &lt;b&gt; &#123;x&#125;");
  });

  it("maps shapes to repos", () => {
    expect(reposForShape("monorepo")).toEqual([{ path: ".", area: "shared" }]);
    expect(reposForShape("separate").map((r) => r.path)).toEqual(["backend", "frontend"]);
    expect(locatePart("monorepo", "frontend")).toEqual({ repo: ".", dirInRepo: "frontend" });
    expect(locatePart("separate", "frontend")).toEqual({ repo: "frontend", dirInRepo: "." });
  });
});

describe("role prompts", () => {
  const ctx = {
    projectName: "Todo",
    shape: "monorepo" as const,
    stack: getStack("node-react"),
    settings: { e2e: "playwright" as const, unitBackend: "vitest" as const, unitFrontend: "vitest" as const },
  };

  it("give each role the project conventions", () => {
    expect(systemPrompt("coder", ctx)).toContain("Express 5");
    expect(systemPrompt("reviewer", ctx)).toContain("read-only");
  });

  it("restrict roles appropriately", () => {
    expect(roleAccess("reviewer").mode).toBe("read-only");
    expect(roleAccess("test-author").writable).toContain("**/*.test.*");
    expect(roleAccess("coder").mode).toBe("full");
  });

  it("include feedback and diff", () => {
    const p = coderPrompt(
      { title: "API", description: "Build it", files: ["backend/**"], area: "backend" },
      { review: { verdict: "request-changes", issues: [{ severity: "major", message: "missing 404", file: "a.ts", line: 3 }] } },
    );
    expect(p).toContain("[major] (a.ts:3) missing 404");
    expect(reviewerPrompt({ title: "API", description: "d" }, "+added line")).toContain("+added line");
  });
});
