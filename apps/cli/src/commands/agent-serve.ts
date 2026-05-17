import { loadCredentials, type Credentials } from "../lib/credentials.js";
import { getJson, postJson } from "../lib/api.js";

/**
 * `octp agent serve` — register this machine as a local agent for the
 * authenticated organisation and run a polling loop that claims LLM
 * tasks dispatched by cloud Octopus, runs them against local Ollama,
 * and posts the results back.
 *
 * Why: lets a developer host their org's review-LLM workload on their
 * own laptop. Cloud Octopus can use models the user has Ollama-pulled
 * locally without paying any API cost.
 *
 * Lifecycle:
 *   1. Read ~/.octopus/credentials. Exit with a helpful message if not signed in.
 *   2. POST /api/agent/register → get agentId (or reuse existing by name).
 *   3. Heartbeat every 30s.
 *   4. Poll /api/agent/llm-tasks every 2s. For each claimed task:
 *        run via local Ollama → POST /api/agent/llm-tasks/<id>/complete.
 *   5. On SIGINT: POST /api/agent/disconnect, exit 0.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 2000;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

type AgentRegisterResponse = {
  agentId: string;
  agentName: string;
};

type LlmTask = {
  id: string;
  modelId: string;
  system: string | null;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  createdAt: string;
};

type OllamaResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function agentServeCommand(argv: string[]): Promise<number> {
  const creds = await loadCredentials();
  if (!creds) {
    console.error(
      "No credentials. Run `octp` to sign in first, or `octp onboard` to redo the wizard.",
    );
    return 2;
  }

  // Parse optional flags
  const agentName = flagValue(argv, "--name") ?? defaultAgentName();
  const verbose = argv.includes("--verbose") || argv.includes("-v");

  console.log(`octp agent serve — connecting to ${creds.baseUrl} as ${creds.orgName} / ${agentName}`);

  // Quick Ollama health-check so the user finds out about a stopped daemon
  // before tasks start landing.
  const ollamaUp = await checkOllama();
  if (!ollamaUp) {
    console.error(
      `Could not reach Ollama at ${OLLAMA_BASE_URL}. Start it with \`ollama serve\` and try again.`,
    );
    return 2;
  }
  console.log(`✓ Ollama reachable at ${OLLAMA_BASE_URL}`);

  const reg = await registerAgent(creds, agentName);
  if (!reg.ok) {
    console.error(`Register failed: ${reg.error}`);
    return 1;
  }
  const { agentId } = reg.data;
  console.log(`✓ Registered as agent ${agentId}`);

  // Shutdown: clear timers, wait briefly for any in-flight task to post its
  // result so the server doesn't see a hung "claimed" task, then disconnect.
  // The shuttingDown flag is checked inside the poll/heartbeat loops so they
  // exit before this function calls process.exit().
  let shuttingDown = false;
  let inFlightTask: Promise<void> | null = null;
  const SHUTDOWN_GRACE_MS = 5000;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down — sending disconnect …");
    if (heartbeat) clearInterval(heartbeat);
    // Give the in-flight task up to SHUTDOWN_GRACE_MS to post its result.
    if (inFlightTask) {
      await Promise.race([
        inFlightTask,
        sleep(SHUTDOWN_GRACE_MS),
      ]).catch(() => {});
    }
    await postJson(`${creds.baseUrl}/api/agent/disconnect`, { agentId }, creds.token).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Heartbeat loop
  heartbeat = setInterval(async () => {
    if (shuttingDown) return;
    await postJson(`${creds.baseUrl}/api/agent/heartbeat`, { agentId }, creds.token).catch((e) => {
      if (verbose) console.error("[heartbeat]", e instanceof Error ? e.message : String(e));
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  // Polling loop
  console.log(`Polling for tasks every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
  while (!shuttingDown) {
    try {
      const tasks = await fetchTasks(creds, agentId);
      for (const task of tasks) {
        if (shuttingDown) break;
        if (verbose) console.log(`  task ${task.id} model=${task.modelId}`);
        // Track the in-flight task so shutdown can await it.
        inFlightTask = runOneTask(creds, agentId, task, verbose);
        try {
          await inFlightTask;
        } finally {
          inFlightTask = null;
        }
      }
    } catch (e) {
      if (verbose) console.error("[poll]", e instanceof Error ? e.message : String(e));
    }
    if (!shuttingDown) await sleep(POLL_INTERVAL_MS);
  }

  return 0;
}

async function checkOllama(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}

async function registerAgent(creds: Credentials, agentName: string) {
  return await postJson<AgentRegisterResponse>(
    `${creds.baseUrl}/api/agent/register`,
    {
      name: agentName,
      capabilities: ["llm-completion", "ollama"],
      machineInfo: {
        os: process.platform,
        hostname: process.env.HOSTNAME ?? "",
        nodeVersion: process.version,
      },
    },
    creds.token,
  );
}

async function fetchTasks(creds: Credentials, agentId: string): Promise<LlmTask[]> {
  const res = await getJson<{ tasks: LlmTask[] }>(
    `${creds.baseUrl}/api/agent/llm-tasks?agentId=${encodeURIComponent(agentId)}`,
    { headers: { authorization: `Bearer ${creds.token}` } },
  );
  if (!res.ok) throw new Error(res.error);
  return res.data.tasks;
}

async function runOneTask(
  creds: Credentials,
  agentId: string,
  task: LlmTask,
  verbose: boolean,
): Promise<void> {
  const completeUrl = `${creds.baseUrl}/api/agent/llm-tasks/${task.id}/complete`;
  try {
    if (!task.modelId.startsWith("ollama:") && !task.modelId.includes(":")) {
      // Not an Ollama-prefixed model and not bare — assume Ollama anyway,
      // but log so the user knows what's happening.
      if (verbose) console.log(`  (assuming Ollama for unprefixed model "${task.modelId}")`);
    }
    const model = task.modelId.startsWith("ollama:") ? task.modelId.slice(7) : task.modelId;

    const messages: { role: string; content: string }[] = [];
    if (task.system) messages.push({ role: "system", content: task.system });
    for (const m of task.messages) messages.push({ role: m.role, content: m.content });

    const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ollama" },
      body: JSON.stringify({ model, max_tokens: task.maxTokens, messages, stream: false }),
    });
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as OllamaResponse;
    const text = body.choices?.[0]?.message?.content ?? "";

    // agentId is REQUIRED by the server's /complete endpoint: it verifies
    // the caller is the agent that originally claimed the task and returns
    // 403 on mismatch, preventing one agent from overwriting another's
    // in-flight result.
    await postJson(
      completeUrl,
      {
        agentId,
        text,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
        },
      },
      creds.token,
    );
    if (verbose) console.log(`  ✓ completed ${task.id} (${text.length} chars)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ failed ${task.id}: ${msg}`);
    await postJson(completeUrl, { agentId, error: msg }, creds.token).catch(() => {});
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("-")) return undefined;
  return v;
}

function defaultAgentName(): string {
  const host = process.env.HOSTNAME ?? "agent";
  return `${host}-${process.pid}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
