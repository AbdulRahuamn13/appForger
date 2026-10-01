import { describe, expect, it } from "vitest";
import { extractJson, isRateLimitMessage, parseReview, slugify } from "../src/index.ts";

describe("extractJson", () => {
  it("prefers a json fence", () => {
    expect(extractJson('Here:\n```json\n{"a": 1}\n```\nand {"b": 2}')).toEqual({ a: 1 });
  });

  it("finds a bare object inside prose", () => {
    expect(extractJson('The verdict is {"verdict": "approve", "issues": []} — done.')).toEqual({
      verdict: "approve",
      issues: [],
    });
  });

  it("handles braces inside strings", () => {
    expect(extractJson('x {"msg": "use {curly} and ]"} y')).toEqual({ msg: "use {curly} and ]" });
  });

  it("returns undefined when nothing parses", () => {
    expect(extractJson("no json here {oops")).toBeUndefined();
  });
});

describe("parseReview", () => {
  it("parses an approval", () => {
    const r = parseReview('```json\n{"verdict":"approve","issues":[{"severity":"nit","message":"rename x"}]}\n```');
    expect(r.verdict).toBe("approve");
    expect(r.issues).toHaveLength(1);
  });

  it("downgrades an approval that lists a blocker", () => {
    const r = parseReview('{"verdict":"approve","issues":[{"severity":"blocker","message":"SQL injection"}]}');
    expect(r.verdict).toBe("request-changes");
  });

  it("treats malformed output as a blocking request for changes", () => {
    const r = parseReview("Looks good to me!");
    expect(r.verdict).toBe("request-changes");
    expect(r.issues[0]?.severity).toBe("blocker");
  });
});

describe("helpers", () => {
  it("slugifies", () => {
    expect(slugify("Todo API + React list!")).toBe("todo-api-react-list");
    expect(slugify("???")).toBe("task");
  });

  it("spots rate-limit errors", () => {
    expect(isRateLimitMessage("Claude usage limit reached")).toBe(true);
    expect(isRateLimitMessage("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRateLimitMessage("syntax error")).toBe(false);
  });
});
