import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
mock.module("server-only", () => ({}));
globalThis.fetch = (() => { throw new Error("Unexpected network access"); }) as typeof fetch;
process.env.OPENAI_API_KEY = "synthetic-platform";
process.env.PROMPT_CACHE_TTL = "5m";
process.env.PLATFORM_MARKUP = "1.2";
type Body = { prompt_cache_key?: string; prompt_cache_retention?: string; input?: unknown; messages: unknown[];
  system: { text: string; cache_control: { ttl: string } }[] };
const calls: { provider: string; key?: string; body: Body }[] = [];
let keys: Record<string, string | null> = {};
const stored: { inputTokens: number }[] = [], debits: number[] = [];
mock.module("@octopus/db", () => ({ prisma: {
  availableModel: { findMany: async () => [{ modelId: "claude-opus-5-5", provider: "anthropic", inputPrice: 4, outputPrice: 20 }] },
  organization: { findUnique: async () => keys },
  aiUsage: { create: async ({ data }: { data: { inputTokens: number } }) => { stored.push(data); return { id: "synthetic" }; }, update: async () => ({}) },
} }));
mock.module("../../crypto", () => ({ decryptStringMaybeLegacy: (key: string) => key }));
mock.module("../../credits", () => ({ deductCredits: async (_org: string, amount: number) => { debits.push(amount); } }));
class FakeOpenAI {
  constructor(private options: { apiKey: string }) {}
  responses = { create: async (body: unknown) => { calls.push({ provider: "responses", key: this.options.apiKey, body: body as Body }); return {
    output_text: "ok", status: "completed", usage: { input_tokens: 15000, output_tokens: 0, input_tokens_details: { cached_tokens: 10000, cache_write_tokens: 3000 } },
  }; } };
  chat = { completions: { create: async (body: unknown) => { calls.push({ provider: "chat", key: this.options.apiKey, body: body as Body }); return {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 15000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 10000, cache_write_tokens: 3000 } },
  }; } } };
}
class FakeAnthropic {
  constructor(private options: { apiKey?: string }) {}
  messages = { stream: (body: unknown) => { calls.push({ provider: "anthropic", key: this.options.apiKey, body: body as Body }); return { finalMessage: async () => ({
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 },
  }) }; } };
}
mock.module("openai", () => ({ default: FakeOpenAI }));
mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
const { openaiProvider } = await import("../../providers/openai");
const { anthropicProvider } = await import("../../providers/anthropic");
mock.module("../../providers", () => ({ getProvider: (name: string) => name === "openai" ? openaiProvider : anthropicProvider }));
const { createAiMessage } = await import("../../ai-router");
const { logAiUsage } = await import("../../ai-usage");
const { calcCost } = await import("../../cost");
const { substitutePromptVars } = await import("../../prompt-substitute");
const { CACHE_BREAKPOINT } = await import("../../providers/system-cache");
const template = readFileSync(new URL("../../../prompts/SYSTEM_PROMPT.md", import.meta.url), "utf8");
function system(suffix: string) {
  const vars = Object.fromEntries([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => [m[1], ""]));
  return substitutePromptVars(template, { ...vars, PROVIDER: "GitHub", REVIEW_LANGUAGE: "en", REVIEW_LANGUAGE_NAME: "English",
    RE_REVIEW_CONTEXT: `prior-${suffix}`, PATTERN_RULES: `rules-${suffix}`, CONFLICT_DETECTION: `conflict-${suffix}`, CODEBASE_CONTEXT: `code-${suffix}` });
}
const messages = [{ role: "user" as const, content: "initial" }, { role: "assistant" as const, content: "prior answer" }, { role: "user" as const, content: "follow-up" }];
const params = { model: "gpt-5.3-codex", maxTokens: 128, cacheSystem: true, system: system("one"), messages, effort: "medium" as const };
const first = await createAiMessage(params, "org-a");
const initial = calls.at(-1)!;
assert.match(initial.body.prompt_cache_key, /^[a-f0-9]{64}$/);
assert.deepEqual(initial.body.input, messages);
assert.equal(first.usage.cacheWriteTokens, 3000);
assert.equal(first.usage.inputTokens, 15000);
assert.equal(initial.body.prompt_cache_retention, undefined);
await createAiMessage({ ...params, system: system("two") }, "org-a");
assert.equal(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
const anthropic = await createAiMessage({ ...params, model: "claude-opus-5-5" }, "org-a");
const a = calls.at(-1)!;
await createAiMessage({ ...params, model: "claude-opus-5-5", system: system("two") }, "org-a");
const b = calls.at(-1)!;
assert.equal(a.body.system[0].text, b.body.system[0].text);
assert.equal(a.body.system[0].cache_control.ttl, "5m");
for (const value of ["prior-one", "rules-one", "conflict-one", "code-one"]) {
  assert(a.body.system[1].text.includes(value)); assert(!a.body.system[0].text.includes(value));
}
assert.deepEqual(a.body.messages, messages);
await createAiMessage(params, "org-a");
assert.equal(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
for (const changed of [{ ...params, model: "gpt-6-astra" }, { ...params, system: "changed stable prefix" + CACHE_BREAKPOINT + "suffix" }]) {
  await createAiMessage(changed, "org-a"); assert.notEqual(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
}
await createAiMessage(params, "org-b"); assert.notEqual(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
keys = { openaiApiKey: "synthetic-byok" };
await createAiMessage(params, "org-a"); assert.equal(calls.at(-1)!.key, "synthetic-byok"); assert.notEqual(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
keys = {};
for (const changed of [{ ...params, cacheSystem: false }, { ...params, system: "" }, { ...params, system: CACHE_BREAKPOINT + "only suffix" }]) {
  await createAiMessage(changed, "org-a"); assert.equal(calls.at(-1)!.body.prompt_cache_key, undefined);
}
await createAiMessage(params, ""); assert.equal(calls.at(-1)!.body.prompt_cache_key, undefined);
const chat = await createAiMessage({ ...params, model: "gpt-6-astra" }, "org-a");
assert.equal(chat.usage.cacheWriteTokens, 3000);
assert.deepEqual(calls.at(-1)!.body.messages.slice(1), messages);
await logAiUsage({ ...anthropic.usage, provider: "anthropic", model: "claude-opus-5-5", operation: "review", organizationId: "org-a" });
assert.equal(stored.at(-1).inputTokens, 1000);
assert(Math.abs(debits.at(-1)! - .006 * 1.2) < 1e-12);
const rates = new Map([["gpt-6-astra", { input: 10, output: 50 }]]);
process.env.PROMPT_CACHE_TTL = "1h";
assert(Math.abs(calcCost(rates, "gpt-6-astra", 15000, 0, 10000, 3000, "openai") - .0675 * 1.2) < 1e-12);
console.log("PASS provider switching, stable prefixes, scoped affinity, retained history and cache accounting");
