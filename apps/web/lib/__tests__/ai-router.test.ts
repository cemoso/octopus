import { describe, it, expect, mock, beforeAll } from "bun:test";

// Mock prisma before importing modules that pull it in at module load.
mock.module("@octopus/db", () => ({
  prisma: {
    availableModel: {
      findMany: async () => [
        { modelId: "claude-sonnet-4-6-20250619", provider: "anthropic" },
        { modelId: "gpt-4o", provider: "openai" },
        { modelId: "gemini-2.5-pro", provider: "google" },
        { modelId: "ollama:qwen2.5-coder:32b", provider: "ollama" },
      ],
    },
    organization: {
      findUnique: async () => ({
        anthropicApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        grokApiKey: null,
        openrouterApiKey: null,
      }),
    },
  },
}));

// Mock provider SDK imports so the registry can load without real network
// configuration. The mock provider is the only one we actually exercise here.
mock.module("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [], usage: {} }) } } }));
mock.module("openai", () => ({ default: class { chat = { completions: { create: async () => ({ choices: [], usage: {} }) } } } }));
mock.module("@google/generative-ai", () => ({ GoogleGenerativeAI: class { getGenerativeModel() { return { generateContent: async () => ({ response: { text: () => "", usageMetadata: {} } }) }; } } }));

import { createAiMessage, resolveProvider, type AiProvider } from "@/lib/ai-router";

describe("resolveProvider", () => {
  it("resolves DB-cached models", async () => {
    expect(await resolveProvider("claude-sonnet-4-6-20250619")).toBe("anthropic");
    expect(await resolveProvider("gpt-4o")).toBe("openai");
    expect(await resolveProvider("gemini-2.5-pro")).toBe("google");
    expect(await resolveProvider("ollama:qwen2.5-coder:32b")).toBe("ollama");
  });

  it("falls back to prefix matching for unknown models", async () => {
    expect(await resolveProvider("claude-future-model-xyz")).toBe("anthropic");
    expect(await resolveProvider("gpt-5-not-yet-released")).toBe("openai");
    expect(await resolveProvider("o3-newer")).toBe("openai");
    expect(await resolveProvider("o4-mini-v2")).toBe("openai");
    expect(await resolveProvider("codex-experimental")).toBe("openai");
    expect(await resolveProvider("gemini-future")).toBe("google");
    expect(await resolveProvider("grok-4-fast")).toBe("grok");
    expect(await resolveProvider("openrouter/anthropic/claude-sonnet-4-6")).toBe("openrouter");
    expect(await resolveProvider("ollama:llama3.3")).toBe("ollama");
    expect(await resolveProvider("mock-test")).toBe("mock");
    expect(await resolveProvider("mock-fail-test")).toBe("mock-fail");
  });

  it("defaults to anthropic when no prefix matches", async () => {
    expect(await resolveProvider("completely-unknown-model")).toBe("anthropic");
  });
});

describe("createAiMessage with mock provider", () => {
  it("dispatches to the mock provider and returns its canned response", async () => {
    const response = await createAiMessage(
      {
        model: "mock-test",
        maxTokens: 100,
        messages: [{ role: "user", content: "Review this code." }],
      },
      "org-id-placeholder",
    );
    expect(response.provider).toBe("mock" as AiProvider);
    expect(response.model).toBe("mock-test");
    // Generic mock payload contains the canned review shape.
    expect(response.text).toContain("overallScore");
    expect(response.text).toContain("findings");
    expect(response.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe("createAiMessage with mock-fail provider", () => {
  it("wraps mock-fail errors with the AI provider error prefix", async () => {
    await expect(
      createAiMessage(
        {
          model: "mock-fail-test",
          maxTokens: 100,
          messages: [{ role: "user", content: "anything" }],
        },
        "org-id-placeholder",
      ),
    ).rejects.toThrow(/AI provider mock-fail failed:.*deliberate failure/);
  });
});
