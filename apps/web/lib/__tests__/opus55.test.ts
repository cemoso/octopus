import { describe, expect, it } from "bun:test";
import { prepareAnthropicRequest } from "../providers/anthropic-request";

describe("Opus 5.5 requests", () => {
  const base = { model: "claude-opus-5-5", maxTokens: 1000, thinking: "disabled" as const, messages: [{ role: "user" as const, content: "Return JSON" }] };
  it("uses native JSON schema with adaptive thinking instead of rejected forced tools", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const body = prepareAnthropicRequest({ ...base, responseSchema: { name: "result", schema } }, "5m");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema } });
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(64000);
  });
  it("preserves legacy structured output and ordinary Opus text requests", () => {
    expect(prepareAnthropicRequest({ ...base, model: "claude-sonnet-4-6", responseSchema: { name: "result", schema: { type: "object" } } }, "5m").tool_choice).toEqual({ type: "tool", name: "result" });
    expect(prepareAnthropicRequest(base, "5m").output_config).toEqual({ effort: "medium" });
  });
});
