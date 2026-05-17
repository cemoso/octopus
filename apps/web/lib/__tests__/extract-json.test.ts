import { describe, it, expect } from "bun:test";
import {
  extractJson,
  extractJsonObject,
  safeProviderPreview,
} from "@/lib/extract-json";

describe("extractJson — tier 1 (strict parse)", () => {
  it("parses a clean JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses with leading/trailing whitespace", () => {
    expect(extractJson('  \n  {"a":1}\n  ')).toEqual({ a: 1 });
  });

  it("parses an array root via the strict path", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses a primitive via the strict path", () => {
    expect(extractJson("42")).toBe(42);
    expect(extractJson('"hello"')).toBe("hello");
    expect(extractJson("true")).toBe(true);
    expect(extractJson("null")).toBeNull();
  });
});

describe("extractJson — tier 2 (code fence)", () => {
  it("strips a ```json fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips a bare ``` fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("handles preface text before the fence", () => {
    const text = 'Sure, here is the JSON:\n```json\n{"score":4}\n```\nLet me know.';
    expect(extractJson(text)).toEqual({ score: 4 });
  });

  it("returns null when the fenced content is not JSON", () => {
    expect(extractJson("```\nnot json\n```")).toBeNull();
  });
});

describe("extractJson — tier 3 (balanced-brace)", () => {
  it("extracts an object embedded in narrative text", () => {
    const text = 'Here is what I found: {"severity":"🔴","title":"oops"}. Let me know.';
    expect(extractJson(text)).toEqual({ severity: "🔴", title: "oops" });
  });

  it("ignores braces inside strings", () => {
    const text = 'The template was: {"raw":"hello {name}","ok":true} done.';
    expect(extractJson(text)).toEqual({ raw: "hello {name}", ok: true });
  });

  it("handles escaped quotes inside string values", () => {
    const text = '{"q":"she said \\"hi\\"","ok":true}';
    expect(extractJson(text)).toEqual({ q: 'she said "hi"', ok: true });
  });

  it("skips a malformed earlier candidate and finds a later valid one", () => {
    const text = '{not json} then later {"valid":42}';
    expect(extractJson(text)).toEqual({ valid: 42 });
  });

  it("returns null when no balanced object exists", () => {
    expect(extractJson("{ unbalanced")).toBeNull();
  });
});

describe("extractJson — edge cases", () => {
  it("returns null for empty input", () => {
    expect(extractJson("")).toBeNull();
    expect(extractJson("   ")).toBeNull();
  });

  it("returns null for plain prose", () => {
    expect(extractJson("Sorry, I cannot answer that.")).toBeNull();
  });

  it("handles deeply nested objects via the balanced-brace pass", () => {
    const text = 'Result: {"a":{"b":{"c":{"d":1}}}}';
    expect(extractJson(text)).toEqual({ a: { b: { c: { d: 1 } } } });
  });
});

describe("extractJsonObject", () => {
  it("returns the object when the root is an object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null when the root is an array", () => {
    expect(extractJsonObject("[1,2]")).toBeNull();
  });

  it("returns null when the root is a primitive", () => {
    expect(extractJsonObject("42")).toBeNull();
    expect(extractJsonObject('"hello"')).toBeNull();
  });

  it("returns null when extraction fails", () => {
    expect(extractJsonObject("not json")).toBeNull();
  });
});

describe("safeProviderPreview", () => {
  it("collapses whitespace runs to single spaces", () => {
    expect(safeProviderPreview("hello\n\nworld\t\tfoo")).toBe("hello world foo");
  });

  it("truncates to the configured maximum", () => {
    expect(safeProviderPreview("x".repeat(300), 50)).toHaveLength(50);
  });

  it("trims leading and trailing whitespace before truncating", () => {
    expect(safeProviderPreview("   hello   ", 100)).toBe("hello");
  });
});
