import { describe, expect, it } from "vitest";
import type { RawTestOutput } from "@appforge/core";
import { ProcessRegistry } from "@appforge/workspace";
import { CypressRunner, parseJestJson, parseJUnit, parsePlaywrightJson, parseTrx, PlaywrightRunner, PytestRunner, VitestRunner, XunitRunner } from "../src/index.ts";

const PYTEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.05">
  <testcase classname="tests.test_todos" name="test_create" time="0.010"/>
  <testcase classname="tests.test_todos" name="test_delete" time="0.020"><failure message="assert 404 == 204">def test_delete():
&gt;       assert r.status_code == 204
E       assert 404 == 204</failure></testcase>
  <testcase classname="tests.test_todos" name="test_later" time="0"><skipped message="todo"/></testcase>
</testsuite></testsuites>`;

const CYPRESS_XML_1 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="1" failures="0"><testsuite name="Root Suite" tests="0" file="cypress/e2e/todo.cy.ts"></testsuite>
<testsuite name="todos" tests="1" failures="0"><testcase name="todos adds a todo" time="1.2" classname="adds a todo"></testcase></testsuite></testsuites>`;
const CYPRESS_XML_2 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" tests="1" failures="1"><testsuite name="todos" tests="1" failures="1">
<testcase name="todos deletes a todo" time="4.0" classname="deletes a todo"><failure message="Timed out retrying after 4000ms: Expected to find element: [data-testid=delete]" type="AssertionError"><![CDATA[AssertionError: Timed out]]></failure></testcase></testsuite></testsuites>`;

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testName="Api.Tests.TodoTests.Create_ReturnsCreated" outcome="Passed" duration="00:00:00.0123" />
    <UnitTestResult testName="Api.Tests.TodoTests.Delete_Missing_Returns404" outcome="Failed" duration="00:00:01.5000">
      <Output><ErrorInfo><Message>Assert.Equal() Failure: Expected 404, Actual 500</Message><StackTrace>at Api.Tests.TodoTests.Delete</StackTrace></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testName="Api.Tests.TodoTests.Skipped" outcome="NotExecuted" duration="00:00:00" />
  </Results>
  <ResultSummary outcome="Failed"><Counters total="3" executed="2" passed="1" failed="1" /></ResultSummary>
</TestRun>`;

const VITEST_JSON = JSON.stringify({
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  testResults: [
    {
      name: "/repo/backend/test/todos.test.ts",
      status: "failed",
      assertionResults: [
        { ancestorTitles: ["todos"], title: "lists todos", fullName: "todos lists todos", status: "passed", duration: 3 },
        { ancestorTitles: ["todos"], title: "rejects empty titles", status: "failed", duration: 5, failureMessages: ["\u001b[31mAssertionError: expected 201 to be 400\u001b[39m\n    at test/todos.test.ts:12:5"] },
      ],
    },
    { name: "/repo/backend/test/broken.test.ts", status: "failed", message: "SyntaxError: Unexpected token", assertionResults: [] },
  ],
});

const PLAYWRIGHT_JSON = JSON.stringify({
  suites: [
    {
      title: "todo.spec.ts",
      file: "todo.spec.ts",
      specs: [],
      suites: [
        {
          title: "todo list",
          file: "todo.spec.ts",
          specs: [
            { title: "adds a todo", file: "todo.spec.ts", tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed", duration: 812 }] }] },
            {
              title: "completes a todo",
              file: "todo.spec.ts",
              tests: [
                {
                  projectName: "chromium",
                  status: "unexpected",
                  results: [{ status: "failed", duration: 5000, error: { message: "\u001b[31mError: expect(locator).toBeChecked()\u001b[39m\nLocator: getByRole('checkbox')", stack: "at todo.spec.ts:20" }, attachments: [{ name: "trace", path: "test-results/x/trace.zip" }, { name: "screenshot", path: "test-results/x/failed.png" }] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  stats: { expected: 1, unexpected: 1 },
});

describe("report parsers (contract tests)", () => {
  it("parses pytest JUnit XML", () => {
    const cases = parseJUnit([PYTEST_XML]);
    expect(cases.map((c) => [c.name, c.status])).toEqual([
      ["test_create", "passed"],
      ["test_delete", "failed"],
      ["test_later", "skipped"],
    ]);
    expect(cases[1]?.error?.message).toBe("assert 404 == 204");
    expect(cases[1]?.suite).toBe("tests.test_todos");
  });

  it("merges multiple Cypress JUnit files", () => {
    const cases = parseJUnit([CYPRESS_XML_1, CYPRESS_XML_2]);
    expect(cases.map((c) => c.status)).toEqual(["passed", "failed"]);
    expect(cases[1]?.error?.message).toMatch(/Timed out retrying/);
  });

  it("parses .NET TRX", () => {
    const cases = parseTrx([TRX]);
    expect(cases.map((c) => [c.suite, c.name, c.status])).toEqual([
      ["Api.Tests.TodoTests", "Create_ReturnsCreated", "passed"],
      ["Api.Tests.TodoTests", "Delete_Missing_Returns404", "failed"],
      ["Api.Tests.TodoTests", "Skipped", "skipped"],
    ]);
    expect(cases[1]?.durationMs).toBe(1500);
    expect(cases[1]?.error?.message).toContain("Expected 404");
  });

  it("parses Vitest/Jest JSON, including files that fail to load", () => {
    const cases = parseJestJson([VITEST_JSON]);
    expect(cases.map((c) => c.status)).toEqual(["passed", "failed", "failed"]);
    expect(cases[1]?.error?.message).toBe("AssertionError: expected 201 to be 400");
    expect(cases[1]?.suite).toBe("todos");
    expect(cases[2]?.error?.message).toMatch(/SyntaxError/);
  });

  it("parses Playwright JSON with attachments", () => {
    const cases = parsePlaywrightJson([PLAYWRIGHT_JSON]);
    expect(cases.map((c) => [c.suite, c.name, c.status])).toEqual([
      ["todo list", "adds a todo [chromium]", "passed"],
      ["todo list", "completes a todo [chromium]", "failed"],
    ]);
    expect(cases[1]?.error?.message).toBe("Error: expect(locator).toBeChecked()");
    expect(cases[1]?.attachments).toEqual(["test-results/x/trace.zip", "test-results/x/failed.png"]);
  });
});

describe("runner adapters", () => {
  const processes = new ProcessRegistry();
  const raw = (reportFiles: string[], exitCode = 1): RawTestOutput => ({ exitCode, stdout: "out", stderr: "", reportFiles, durationMs: 10 });

  it("turn raw output into a TestReport", () => {
    const report = new PytestRunner(processes).parseResults(raw([PYTEST_XML]), "/x");
    expect(report).toMatchObject({ framework: "pytest", layer: "unit", total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(report.error).toBeUndefined();
  });

  it("flag a crashed runner even without failing cases", () => {
    expect(new VitestRunner(processes).parseResults(raw([]), "/x").error).toMatch(/without a report/);
    expect(new XunitRunner(processes).parseResults(raw([TRX.replace(/outcome="Failed"/g, 'outcome="Passed"')], 2), "/x").error).toMatch(/exited with code 2/);
  });

  it("build the headless commands from the plan", () => {
    expect(new PlaywrightRunner(processes).command({}).args).toEqual(["playwright", "test", "--reporter=json"]);
    expect(new CypressRunner(processes).command({ baseUrl: "http://127.0.0.1:5000" }).args).toContain("baseUrl=http://127.0.0.1:5000");
    expect(new VitestRunner(processes).command({ filter: "todos" }).args.at(-1)).toBe("todos");
    expect(new XunitRunner(processes).command({}).args.slice(0, 4)).toEqual(["test", "Api.Tests", "--logger", "trx"]);
    expect(new PytestRunner(processes).command({ filter: "create" }).args).toEqual(["-m", "pytest", "-q", "--junitxml=.appforge/reports/pytest.xml", "-k", "create"]);
  });
});
