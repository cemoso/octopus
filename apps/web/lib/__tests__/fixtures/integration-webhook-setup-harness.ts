import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
mock.module("@/lib/crypto", () => ({ decryptStringMaybeLegacy: (value: string) => value, decryptString: (value: string) => value, encryptString: (value: string) => value }));
const originalIntegration = { id: "integration", accessToken: "fixture-token", refreshToken: "fixture-refresh", tokenExpiresAt: new Date(Date.now() + 3_600_000), gitlabHost: "https://gitlab.example.test", namespacePath: "group", workspaceSlug: "workspace", webhookSecret: "fixture-secret" };
let integration = { ...originalIntegration };
let locked = false;
let denyLock = false;
mock.module("@octopus/db", () => ({ prisma: {
  bitbucketIntegration: { findUnique: async () => integration },
  gitlabIntegration: { findUnique: async () => integration },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    let acquired = false;
    try {
      return await run({ $queryRaw: async () => {
        acquired = !locked && !denyLock;
        if (acquired) locked = true;
        return [{ acquired }];
      } });
    } finally { if (acquired) locked = false; }
  },
} }));

const { createWebhook } = await import("../../bitbucket");
const { createProjectWebhook } = await import("../../gitlab");
type Hook = Record<string, unknown>;
for (const provider of ["bitbucket", "gitlab"] as const) {
  const callback = `https://octopus.example.test/api/${provider}/webhook`;
  const ownedUrl = `${callback}?octopus_org=org_fixture`;
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  let hooks: Hook[] = [];
  let failList = false;
  let failCreate = false;
  let paginated = false;
  let reconnectDuringList = false;
  const foreign = provider === "bitbucket"
    ? { uuid: "foreign", url: "https://unrelated.example.test/hook", description: "Keep me", active: true, events: ["repo:push"] }
    : { id: 2, url: "https://unrelated.example.test/hook", note_events: false };
  const known = provider === "bitbucket"
    ? { uuid: "hook1", url: callback, description: "Octopus Review (org_fixture)", active: true, secret_set: true, events: ["pullrequest:created", "pullrequest:updated", "pullrequest:comment_created"] }
    : { id: 1, url: ownedUrl, note_events: true, merge_requests_events: true, enable_ssl_verification: true, token_present: true, alert_status: "executable", disabled_until: null };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert(url.startsWith(provider === "bitbucket" ? "https://api.bitbucket.org/2.0/workspaces/" : "https://gitlab.example.test/api/v4/projects/"));
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === "GET") {
      if (reconnectDuringList) integration = { ...originalIntegration, gitlabHost: "https://replacement.example.test", namespacePath: "replacement", workspaceSlug: "replacement", accessToken: "replacement-token" };
      if (failList) return new Response("sensitive provider response", { status: 403 });
      const page2 = new URL(url).searchParams.get("page") === "2";
      const values = paginated && !page2 ? [foreign] : hooks;
      if (provider === "bitbucket") return Response.json({ values, ...(paginated && !page2 ? { next: "https://untrusted.example.test/no-token" } : {}) });
      return Response.json(values, { headers: paginated && !page2 ? { "x-next-page": "2" } : {} });
    }
    assert.equal(method, "POST", "Setup must not modify or delete any existing hook");
    if (failCreate) return new Response("secret-bearing create response", { status: 403 });
    assert.equal(provider === "bitbucket" ? body.secret : body.token, "fixture-secret");
    assert.equal(body.url, provider === "bitbucket" ? callback : ownedUrl);
    hooks.push({ ...known });
    return Response.json(known, { status: 201 });
  }) as typeof fetch;
  const setup = (id?: string) => provider === "bitbucket"
    ? createWebhook("org_fixture", "workspace", callback, "fixture-secret", id, originalIntegration)
    : createProjectWebhook("org_fixture", "group/project", callback, "fixture-secret", id, originalIntegration);

  integration = { ...originalIntegration, gitlabHost: "https://replacement.example.test", namespacePath: "replacement", workspaceSlug: "replacement", accessToken: "replacement-token" };
  await assert.rejects(setup(), /connection changed/);
  assert.equal(calls.length, 0, "A reconnected binding must not receive an old project's request or webhook secret");
  integration = { ...originalIntegration };
  reconnectDuringList = true;
  await assert.rejects(setup(), /connection changed/);
  assert(calls.every(c => c.method === "GET"), "Reconnect during hook listing must prevent creation");
  reconnectDuringList = false;
  integration = { ...originalIntegration };
  calls.length = 0;

  failList = true;
  await assert.rejects(setup(), /Could not check/);
  assert(!calls.some(c => c.method === "POST"));
  failList = false;
  failCreate = true;
  await assert.rejects(setup(), /Could not create/);
  failCreate = false;
  calls.length = 0;
  hooks = [{ ...foreign }];
  await setup();
  await setup();
  assert.equal(calls.filter(c => c.method === "POST").length, 1, "Repair followed by retry must not duplicate hooks");
  assert.deepEqual(hooks[0], foreign, "Unrelated hooks stay unchanged");

  calls.length = 0;
  paginated = true;
  await setup();
  assert.equal(calls.length, 2);
  assert(calls.every(c => c.method === "GET"));
  paginated = false;

  calls.length = 0;
  hooks = [{ ...known, ...(provider === "bitbucket" ? { description: "Octopus Review" } : { url: callback }) }];
  await assert.rejects(setup(), /no saved ownership evidence/);
  assert(!calls.some(c => c.method === "POST"));
  await setup(provider === "bitbucket" ? "hook1" : "1");
  assert(!calls.some(c => c.method === "POST"), "Known legacy hook is reused");

  hooks = [{ ...known, ...(provider === "bitbucket" ? { active: false } : { alert_status: "permanently_disabled" }) }];
  await assert.rejects(setup(), /needs attention/);
  assert(!calls.some(c => c.method === "POST"));

  calls.length = 0;
  denyLock = true;
  await assert.rejects(setup(), /already running/);
  assert.equal(calls.length, 0);
  denyLock = false;
}
console.log("provider webhook setup: passed");
