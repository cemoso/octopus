import "server-only";
import OpenAI from "openai";
import { prisma } from "@octopus/db";
import type { Provider, AiCreateParams, AiResponse } from "./index";

/**
 * OpenCode — open-source coding-agent server. Recent versions expose an
 * OpenAI-compatible Chat Completions endpoint, so we reuse the OpenAI SDK
 * with a custom baseURL.
 *
 * Per-org config:
 *   Organization.opencodeBaseUrl — e.g. https://opencode.internal.acme.com
 *   Organization.opencodeApiKey  — bearer token for the OpenCode server
 *
 * Env override for self-hosters:
 *   OPENCODE_BASE_URL + OPENCODE_API_KEY
 */

async function resolveConfig(orgId?: string | null): Promise<{ baseUrl: string; apiKey: string } | null> {
  const envBase = process.env.OPENCODE_BASE_URL;
  const envKey = process.env.OPENCODE_API_KEY;
  if (envBase && envKey) return { baseUrl: stripTrailingSlash(envBase), apiKey: envKey };

  if (!orgId) return null;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { opencodeBaseUrl: true, opencodeApiKey: true },
  });
  if (org?.opencodeBaseUrl && org?.opencodeApiKey) {
    return { baseUrl: stripTrailingSlash(org.opencodeBaseUrl), apiKey: org.opencodeApiKey };
  }
  return null;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export const opencodeProvider: Provider = {
  name: "opencode" as never,
  supportsJsonSchema: true,
  async create(
    params: AiCreateParams,
    _apiKey?: string | null,
    orgId?: string,
  ): Promise<AiResponse> {
    const config = await resolveConfig(orgId ?? null);
    if (!config) {
      throw new Error(
        "OpenCode is not configured. Set OPENCODE_BASE_URL + OPENCODE_API_KEY env vars, " +
          "or configure opencodeBaseUrl + opencodeApiKey on the organization.",
      );
    }

    const client = new OpenAI({ apiKey: config.apiKey, baseURL: `${config.baseUrl}/v1` });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    for (const m of params.messages) messages.push({ role: m.role, content: m.content });

    const model = params.model.startsWith("opencode:") ? params.model.slice(9) : params.model;

    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: params.maxTokens,
      messages,
      ...(params.responseSchema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: params.responseSchema.name,
                schema: params.responseSchema.schema,
                strict: true,
              },
            },
          }
        : {}),
    });

    const text = response.choices[0]?.message?.content ?? "";

    return {
      text,
      provider: "opencode" as never,
      model: params.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
  },
};
