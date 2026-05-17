import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { prisma } from "@octopus/db";
import type { Provider, AiCreateParams, AiResponse } from "./index";

/**
 * Claude Code — Anthropic's coding-agent CLI. Two auth modes, selectable
 * per-org via Organization.claudeCodeAuthMode:
 *
 *   "subscription"  → shell out to the `claude` CLI. The CLI carries the
 *                     user's own auth (Pro / Max subscription OR an API key
 *                     stored in ~/.claude). Octopus never sees the credential.
 *   "api-key"       → use the Anthropic SDK with the org's claudeCodeApiKey
 *                     column. Effectively the same code path as the
 *                     anthropicProvider but billed against this key.
 *
 * Cloud caveat: subscription mode requires the `claude` CLI installed and
 * authed in the runtime environment. The hosted Octopus web container does
 * not have it. Practically, subscription mode only works through the local-
 * agent bridge (Workstream 2 follow-up) where the laptop has `claude`
 * available. The provider returns a clear error if invoked in an environment
 * without the CLI.
 */

type AuthMode = "subscription" | "api-key";

async function loadOrgConfig(orgId?: string | null): Promise<{
  mode: AuthMode;
  apiKey: string | null;
} | null> {
  // Env fallback for self-hosters who want a single global config:
  //   OCTOPUS_CLAUDE_CODE_MODE = "subscription" | "api-key"
  //   ANTHROPIC_API_KEY        (re-used when mode is api-key)
  const envMode = process.env.OCTOPUS_CLAUDE_CODE_MODE as AuthMode | undefined;
  if (envMode === "subscription" || envMode === "api-key") {
    return { mode: envMode, apiKey: process.env.ANTHROPIC_API_KEY ?? null };
  }

  if (!orgId) return null;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { claudeCodeAuthMode: true, claudeCodeApiKey: true, anthropicApiKey: true },
  });
  if (!org?.claudeCodeAuthMode) return null;
  const mode = (org.claudeCodeAuthMode as AuthMode) ?? "api-key";
  const apiKey = mode === "api-key" ? org.claudeCodeApiKey ?? org.anthropicApiKey ?? null : null;
  return { mode, apiKey };
}

let platformAnthropic: Anthropic | null = null;

export const claudeCodeProvider: Provider = {
  name: "claude-code" as never,
  supportsJsonSchema: true, // via Anthropic tool-use in api-key mode; subscription mode emits text
  async create(params: AiCreateParams, _apiKey?: string | null): Promise<AiResponse> {
    const config = await loadOrgConfig(null);
    if (!config) {
      throw new Error(
        "Claude Code is not configured. Set Organization.claudeCodeAuthMode " +
          "to 'subscription' or 'api-key', or use the OCTOPUS_CLAUDE_CODE_MODE " +
          "env var. See /docs/providers#claude-code.",
      );
    }

    if (config.mode === "subscription") {
      return await runClaudeCli(params);
    }
    return await runAnthropicApi(params, config.apiKey);
  },
};

// ── api-key mode ─────────────────────────────────────────────────────────────

async function runAnthropicApi(params: AiCreateParams, apiKey: string | null): Promise<AiResponse> {
  if (!apiKey) {
    throw new Error(
      "Claude Code in api-key mode needs claudeCodeApiKey (or anthropicApiKey as fallback) on the organization.",
    );
  }

  const client = apiKey === platformAnthropic?.apiKey ? platformAnthropic : new Anthropic({ apiKey });
  if (!platformAnthropic) platformAnthropic = client;

  const useTool = params.responseSchema !== undefined;
  const response = await client.messages.create({
    model: params.model.startsWith("claude-code:") ? params.model.slice(12) : params.model,
    max_tokens: params.maxTokens,
    system: params.system
      ? [
          {
            type: "text" as const,
            text: params.system,
            ...(params.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
        ]
      : undefined,
    messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(useTool
      ? {
          tools: [
            {
              name: params.responseSchema!.name,
              description: `Return the response as a ${params.responseSchema!.name} object.`,
              input_schema: params.responseSchema!.schema as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: "tool" as const, name: params.responseSchema!.name },
        }
      : {}),
  });

  let text = "";
  if (useTool) {
    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (toolUse?.type === "tool_use") text = JSON.stringify(toolUse.input);
  } else {
    const textBlock = response.content[0];
    text = textBlock?.type === "text" ? textBlock.text : "";
  }

  return {
    text,
    provider: "claude-code" as never,
    model: params.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

// ── subscription mode (shell out to `claude` CLI) ─────────────────────────────

async function runClaudeCli(params: AiCreateParams): Promise<AiResponse> {
  // Compose the prompt for `claude --print`. The CLI accepts a single
  // positional prompt; for multi-turn, we serialise into a single block.
  const blocks: string[] = [];
  if (params.system) blocks.push(`<system>\n${params.system}\n</system>`);
  for (const m of params.messages) {
    blocks.push(`<${m.role}>\n${m.content}\n</${m.role}>`);
  }
  const prompt = blocks.join("\n\n");

  const args = [
    "--print",
    "--output-format=json",
    `--model=${params.model.startsWith("claude-code:") ? params.model.slice(12) : params.model}`,
    prompt,
  ];

  const result = await runCli("claude", args);
  if (result.exitCode !== 0) {
    throw new Error(
      `claude CLI exited ${result.exitCode}. Is the CLI installed and authed? ` +
        `(stderr: ${result.stderr.slice(0, 200).trim()})`,
    );
  }

  // Best-effort JSON parse; falls back to raw stdout if the CLI changes
  // formats or the user is on an older version.
  let text = result.stdout;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const parsed = JSON.parse(result.stdout) as {
      content?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (typeof parsed.content === "string") text = parsed.content;
    inputTokens = parsed.usage?.input_tokens ?? 0;
    outputTokens = parsed.usage?.output_tokens ?? 0;
  } catch {
    // Older claude CLIs emit plain text; keep stdout as-is.
  }

  return {
    text,
    provider: "claude-code" as never,
    model: params.model,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

type CliResult = { exitCode: number; stdout: string; stderr: string };

function runCli(command: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(
        new Error(
          `Could not spawn \`${command}\`. Is it installed and on PATH? ` +
            `(${e instanceof Error ? e.message : String(e)})`,
        ),
      );
    }
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    child.on("error", (err) => reject(err));
  });
}
