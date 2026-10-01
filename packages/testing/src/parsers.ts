import { XMLParser } from "fast-xml-parser";
import type { TestCaseResult, TestFramework, TestLayer, TestReport } from "@appforge/core";
import { isRecord } from "@appforge/core";

type Totals = Pick<TestReport, "total" | "passed" | "failed" | "skipped">;

export function emptyReport(framework: TestFramework, layer: TestLayer, cwd: string): TestReport {
  return { framework, layer, cwd, startedAt: new Date().toISOString(), durationMs: 0, total: 0, passed: 0, failed: 0, skipped: 0, cases: [] };
}

export function tally(cases: TestCaseResult[]): Totals {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    skipped: cases.filter((c) => c.status === "skipped").length,
  };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped", "UnitTestResult", "property"].includes(name),
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (typeof v === "string" ? v : isRecord(v) ? String(v["#text"] ?? "") : v === undefined ? "" : String(v));
const attr = (node: unknown, name: string): string | undefined => (isRecord(node) && node[`@${name}`] !== undefined ? String(node[`@${name}`]) : undefined);

/** JUnit XML (pytest --junitxml, Cypress junit reporter, Playwright junit, Jest junit). */
export function parseJUnit(docs: string[]): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  for (const doc of docs) {
    const parsed = xml.parse(doc) as Record<string, unknown>;
    const root = parsed.testsuites ?? parsed;
    const visit = (suite: unknown, parentName?: string) => {
      if (!isRecord(suite)) return;
      const suiteName = attr(suite, "name") ?? parentName;
      for (const tc of asArray(suite.testcase as unknown[])) {
        if (!isRecord(tc)) continue;
        const failure = asArray(tc.failure as unknown[])[0] ?? asArray(tc.error as unknown[])[0];
        const skipped = asArray(tc.skipped as unknown[]).length > 0;
        const status: TestCaseResult["status"] = failure !== undefined ? "failed" : skipped ? "skipped" : "passed";
        const result: TestCaseResult = { name: attr(tc, "name") ?? "(unnamed)", status };
        const suiteLabel = attr(tc, "classname") ?? suiteName;
        if (suiteLabel) result.suite = suiteLabel;
        const file = attr(tc, "file") ?? attr(suite, "file");
        if (file) result.file = file;
        const time = Number(attr(tc, "time"));
        if (Number.isFinite(time)) result.durationMs = Math.round(time * 1000);
        if (failure !== undefined) {
          const body = text(failure).trim();
          result.error = { message: attr(failure, "message") ?? (body.split("\n")[0] || "failed"), ...(body ? { stack: body } : {}) };
          const attachments = [...body.matchAll(/\[\[ATTACHMENT\|(.+?)\]\]/g)].map((m) => m[1] as string);
          if (attachments.length) result.attachments = attachments;
        }
        cases.push(result);
      }
      for (const child of asArray(suite.testsuite as unknown[])) visit(child, suiteName);
    };
    if (isRecord(root)) {
      if (root.testsuite) for (const s of asArray(root.testsuite as unknown[])) visit(s);
      else visit(root);
    }
  }
  return cases;
}

/** Visual Studio TRX (`dotnet test --logger trx`). */
export function parseTrx(docs: string[]): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  for (const doc of docs) {
    const parsed = xml.parse(doc) as Record<string, unknown>;
    const run = parsed.TestRun;
    if (!isRecord(run) || !isRecord(run.Results)) continue;
    for (const r of asArray(run.Results.UnitTestResult as unknown[])) {
      if (!isRecord(r)) continue;
      const outcome = (attr(r, "outcome") ?? "").toLowerCase();
      const status: TestCaseResult["status"] = outcome === "passed" ? "passed" : outcome === "failed" || outcome === "error" || outcome === "timeout" ? "failed" : "skipped";
      const name = attr(r, "testName") ?? "(unnamed)";
      const dot = name.lastIndexOf(".");
      const result: TestCaseResult = { name: dot > 0 ? name.slice(dot + 1) : name, status };
      if (dot > 0) result.suite = name.slice(0, dot);
      const duration = attr(r, "duration");
      if (duration) result.durationMs = parseTimeSpan(duration);
      const errorInfo = isRecord(r.Output) && isRecord(r.Output.ErrorInfo) ? r.Output.ErrorInfo : undefined;
      if (status === "failed") {
        const stack = text(errorInfo?.StackTrace).trim();
        result.error = { message: text(errorInfo?.Message).trim() || "failed", ...(stack ? { stack } : {}) };
      }
      cases.push(result);
    }
  }
  return cases;
}

function parseTimeSpan(value: string): number {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return 0;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** Jest `--json` and Vitest `--reporter=json` (Vitest emits the Jest shape). */
export function parseJestJson(docs: string[]): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  for (const doc of docs) {
    let report: unknown;
    try {
      report = JSON.parse(doc);
    } catch {
      continue;
    }
    if (!isRecord(report) || !Array.isArray(report.testResults)) continue;
    for (const file of report.testResults) {
      if (!isRecord(file)) continue;
      const fileName = typeof file.name === "string" ? file.name : undefined;
      const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
      if (assertions.length === 0 && file.status === "failed") {
        // The file itself failed to load (syntax error, missing import...).
        cases.push({ name: "(test file failed to run)", status: "failed", ...(fileName ? { file: fileName } : {}), error: { message: String(file.message ?? "failed") } });
      }
      for (const a of assertions) {
        if (!isRecord(a)) continue;
        const raw = String(a.status ?? "");
        const status: TestCaseResult["status"] = raw === "passed" ? "passed" : raw === "failed" ? "failed" : "skipped";
        const ancestors = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(String).filter(Boolean) : [];
        const result: TestCaseResult = { name: String(a.title ?? a.fullName ?? "(unnamed)"), status };
        if (ancestors.length) result.suite = ancestors.join(" › ");
        if (fileName) result.file = fileName;
        if (typeof a.duration === "number") result.durationMs = Math.round(a.duration);
        const failures = Array.isArray(a.failureMessages) ? a.failureMessages.map(String) : [];
        if (status === "failed") {
          const first = failures[0] ?? "failed";
          result.error = { message: stripAnsi(first.split("\n")[0] ?? first), stack: stripAnsi(failures.join("\n")) };
        }
        cases.push(result);
      }
    }
  }
  return cases;
}

/** Playwright `--reporter=json`. */
export function parsePlaywrightJson(docs: string[]): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  for (const doc of docs) {
    let report: unknown;
    try {
      report = JSON.parse(doc);
    } catch {
      continue;
    }
    if (!isRecord(report)) continue;
    const visit = (suite: unknown, path: string[]) => {
      if (!isRecord(suite)) return;
      const title = typeof suite.title === "string" && suite.title && !/\.(spec|test)\.[jt]sx?$/.test(suite.title) ? [...path, suite.title] : path;
      for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
        if (!isRecord(spec)) continue;
        for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
          if (!isRecord(test)) continue;
          const results = Array.isArray(test.results) ? test.results.filter(isRecord) : [];
          const last = results.at(-1);
          const outcome = String(test.status ?? "");
          // expected/flaky = passed, unexpected = failed, skipped = skipped.
          const status: TestCaseResult["status"] = outcome === "skipped" ? "skipped" : outcome === "unexpected" ? "failed" : "passed";
          const result: TestCaseResult = { name: `${String(spec.title ?? "(unnamed)")}${test.projectName ? ` [${String(test.projectName)}]` : ""}`, status };
          if (title.length) result.suite = title.join(" › ");
          if (typeof spec.file === "string") result.file = spec.file;
          if (last && typeof last.duration === "number") result.durationMs = last.duration;
          if (status === "failed" && last) {
            const err = isRecord(last.error) ? last.error : Array.isArray(last.errors) && isRecord(last.errors[0]) ? last.errors[0] : undefined;
            const message = stripAnsi(String(err?.message ?? "failed"));
            result.error = { message: message.split("\n")[0] ?? message, ...(err?.stack ? { stack: stripAnsi(String(err.stack)) } : {}) };
            const attachments = (Array.isArray(last.attachments) ? last.attachments : [])
              .filter(isRecord)
              .map((a) => (typeof a.path === "string" ? a.path : undefined))
              .filter((p): p is string => !!p);
            if (attachments.length) result.attachments = attachments;
          }
          cases.push(result);
        }
      }
      for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child, title);
    };
    for (const s of Array.isArray(report.suites) ? report.suites : []) visit(s, []);
  }
  return cases;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
