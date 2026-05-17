import "server-only";
import OpenAI from "openai";
import { prisma } from "@octopus/db";
import type { Provider, AiCreateParams, AiResponse } from "./index";

/**
 * ACPX — multiplexer over multiple model vendors (Claude / Pi / Gemini / …)
 * via the Agent Communication Protocol. Most ACP-compatible servers expose
 * an OpenAI-compatible Chat Completions endpoint, so we reuse the OpenAI
 * SDK with a custom baseURL.
 *
 * Per-org config required:
 *   Organization.acpBaseUrl — e.g. https://acpx.internal.acme.com
 *   Organization.acpApiKey  — bearer token for the ACPX gateway
 *
 * Model IDs are namespaced — `acp:claude-…`, `acp:gemini-…`, etc. The prefix
 * routes through this provider; the rest is sent to the ACPX gateway as
 * the model id, which dispatches it to the underlying vendor.
 */

async function resolveConfig(orgId?: string | null): Promise<{ baseUrl: string; apiKey: string } | null> {
  // Env override for self-hosters who set a single global ACPX endpoint.
  const envBase = process.env.ACP_BASE_URL;
  const envKey = process.env.ACP_API_KEY;
  if (envBase && envKey) return { baseUrl: stripTrailingSlash(envBase), apiKey: envKey };

  if (!orgId) return null;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { acpBaseUrl: true, acpApiKey: true },
  });
  if (org?.acpBaseUrl && org?.acpApiKey) {
    return { baseUrl: stripTrailingSlash(org.acpBaseUrl), apiKey: org.acpApiKey };
  }
  return null;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export const acpProvider: Provider = {
  name: "acp" as never,
  supportsJsonSchema: true,
  async create(params: AiCreateParams, _apiKey?: string | null): Promise<AiResponse> {
    // We need an orgId to look up the per-org base URL; ai-router doesn't
    // currently thread it through. Fall back to env-only config for now;
    // when ai-router learns to pass orgId to providers, resolveConfig() can
    // honor it. (See WS5 follow-up.)
    const config = await resolveConfig(null);
    if (!config) {
      throw new Error(
        "ACPX is not configured. Set ACP_BASE_URL + ACP_API_KEY env vars, or " +
          "configure acpBaseUrl + acpApiKey on the organization.",
      );
    }

    const client = new OpenAI({ apiKey: config.apiKey, baseURL: `${config.baseUrl}/v1` });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    for (const m of params.messages) messages.push({ role: m.role, content: m.content });

    // Strip the "acp:" prefix Octopus uses to namespace ACPX models.
    const model = params.model.startsWith("acp:") ? params.model.slice(4) : params.model;

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
      provider: "acp" as never,
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
