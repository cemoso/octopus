import { expect, mock } from "bun:test";
mock.module("server-only", () => ({}));
const org = { id: "org-1", githubInstallationId: 42 };
let identity: unknown = { org, user: { id: "user-1" } };
let member: unknown = { id: "member-1" };
const claimCount = 0;
let starts = 0;
const readArgs: unknown[] = [];
const claimArgs: unknown[] = [];
const db = {
  organizationMember: { findFirst: async (args: unknown) => { readArgs.push(args); return member; } },
  repository: {
    findFirst: async (args: unknown) => { readArgs.push(args); return { id: "repo-1", fullName: "acme/app", isActive: true, dismissedAt: null, installationId: 42, indexStatus: "indexed", analysisStatus: "pending", indexedAt: new Date("2026-09-11T10:00:00Z"), analyzedAt: null }; },
    updateMany: async (args: unknown) => { claimArgs.push(args); return { count: claimCount }; },
  },
};
mock.module("@octopus/db", () => ({ prisma: db }));
mock.module("@/lib/api-auth", () => ({ authenticateApiToken: async () => identity }));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ slug: "octopus" }) }));
mock.module("@/lib/github", () => ({ getInstallationSettingsUrl: async () => "https://github.com/settings/installations/42", listInstallationRepos: async () => [] }));
mock.module("@/lib/repo-sync", () => ({ applyRepositoryEvent: async () => { throw new Error("Unexpected sync"); } }));
mock.module("@/lib/analyzer", () => ({ analyzeRepository: async () => { starts++; return "analysis"; } }));
mock.module("@/lib/events/bus", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/indexing-runner", () => ({ runIndexingInBackground: () => { starts++; } }));
const connect = await import("../../../app/api/cli/repos/connect/route");
const request = (body = { fullName: "acme/app" }) => new Request("https://octopus-review.ai/api/cli/repos/connect", { method: "POST", body: JSON.stringify(body) });
identity = null;
expect((await connect.POST(request())).status).toBe(401);
expect(readArgs).toHaveLength(0);
identity = Response.json({ error: "held" }, { status: 403 });
expect((await connect.POST(request())).status).toBe(403);
expect(readArgs).toHaveLength(0);
identity = { org, user: { id: "user-1" } };
member = null;
expect((await connect.POST(request())).status).toBe(403);
expect(readArgs).toHaveLength(1);
expect(readArgs[0]).toEqual({ where: { organizationId: "org-1", userId: "user-1", deletedAt: null }, select: { id: true } });
member = { id: "member-1" };
expect((await connect.POST(request({ fullName: "../other" }))).status).toBe(400);
const response = await connect.POST(request());
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ state: "connected", repoId: "repo-1" });
expect(readArgs.at(-1)).toMatchObject({ where: { organizationId: "org-1", provider: "github", fullName: { equals: "acme/app", mode: "insensitive" } } });

// A lost compare-and-set must not start a second job.
const index = await import("../../../app/api/cli/repos/[id]/index/route");
const analyze = await import("../../../app/api/cli/repos/[id]/analyze/route");
const params = { params: Promise.resolve({ id: "repo-1" }) };
expect((await index.POST(request() as never, params)).status).toBe(409);
expect((await analyze.POST(request() as never, params)).status).toBe(409);
expect(starts).toBe(0);
expect(claimArgs[0]).toMatchObject({ where: { id: "repo-1", organizationId: "org-1", isActive: true, dismissedAt: null, indexStatus: "indexed", indexedAt: new Date("2026-09-11T10:00:00Z") } });
expect(claimArgs[1]).toMatchObject({ where: { id: "repo-1", organizationId: "org-1", isActive: true, dismissedAt: null, indexStatus: "indexed", analysisStatus: "pending", analyzedAt: null } });
console.log("Scoped connect route and concurrent job claims passed");
