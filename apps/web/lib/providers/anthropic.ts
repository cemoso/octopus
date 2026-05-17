import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Provider, AiCreateParams, AiResponse } from "./index";

let platformClient: Anthropic | null = null;

function getClient(apiKey?: string | null): Anthropic {
  if (apiKey) return new Anthropic({ apiKey });
  if (!platformClient) {
    platformClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return platformClient;
}

export const anthropicProvider: Provider = {
  name: "anthropic",
  async create(params: AiCreateParams, apiKey?: string | null): Promise<AiResponse> {
    const client = getClient(apiKey);

    const response = await client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system
        ? [
            {
              type: "text" as const,
              text: params.system,
              ...(params.cacheSystem
                ? { cache_control: { type: "ephemeral" as const } }
                : {}),
            },
          ]
        : undefined,
      messages: params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    return {
      text,
      provider: "anthropic",
      model: params.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  },
};
