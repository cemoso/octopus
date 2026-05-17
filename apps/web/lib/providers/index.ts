import "server-only";
import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { googleProvider } from "./google";

export type AiProvider = "anthropic" | "openai" | "google";

export type AiMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AiCreateParams = {
  model: string;
  maxTokens: number;
  system?: string;
  messages: AiMessage[];
  cacheSystem?: boolean;
};

export type AiResponse = {
  text: string;
  provider: AiProvider;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
};

export type Provider = {
  name: AiProvider;
  create(params: AiCreateParams, apiKey?: string | null): Promise<AiResponse>;
};

const PROVIDERS: Record<AiProvider, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
};

export function getProvider(name: AiProvider): Provider {
  return PROVIDERS[name];
}
