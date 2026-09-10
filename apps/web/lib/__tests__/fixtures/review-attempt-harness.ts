import { mock } from "bun:test";
import assert from "node:assert/strict";

type Row = { id: string; pullRequestId: string; reviewBody: string; coverage: unknown; headSha: string | null; baseSha: string | null; createdAt?: Date };
type Action = { kind: "create"; data: Row } | { kind: "update"; data: Record<string, unknown>; headSha?: string };
const rows = new Map<string, Row>();
let current: Record<string, unknown> = {};
let currentHead = "a".repeat(40);
let member = true;
let queries = 0;
mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ prisma: {
  reviewAttempt: {
    create: ({ data }: { data: Row }): Action => ({ kind: "create", data }),
    findFirst: async ({ where }: { where: { id: string; pullRequest?: { repository?: { organization?: { id?: string; members?: { some?: { userId?: string; deletedAt?: unknown } }; bannedAt?: unknown; deletedAt?: unknown }; isActive?: boolean } } } }) => {
      queries++;
      const org = where.pullRequest?.repository?.organization;
      // Emulate row selection: an omitted tenant predicate would expose this
      // row to the foreign caller and make the endpoint regression fail.
      if (org?.id && org.id !== "owner-org") return null;
      if (org?.members && (org.members.some?.userId !== "alice" || !member)) return null;
      return rows.get(where.id) ?? null;
    },
  },
  pullRequest: {
    findUnique: async () => ({ id: "pr", headSha: currentHead, number: 1, repository: { id: "repo", provider: "github", fullName: "owner/repo", installationId: 123, organization: { id: "owner-org" } } }),
    updateMany: ({ data, where }: { data: Record<string, unknown>; where: { headSha?: string } }): Action => ({ kind: "update", data, headSha: where.headSha }) },
  $transaction: async (actions: Action[]) => {
    const create = actions.find(a => a.kind === "create");
    if (create?.kind === "create" && rows.has(create.data.id)) throw new Error("duplicate attempt");
    for (const action of actions) {
      if (action.kind === "create") rows.set(action.data.id, structuredClone(action.data));
      else if (!action.headSha || action.headSha === currentHead) current = structuredClone(action.data);
    }
  },
} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async ({ headers }: { headers: Headers }) => headers.get("x-user") ? { user: { id: headers.get("x-user") } } : null } } }));
mock.module("@/lib/api-auth", () => ({ authenticateApiToken: async (request: Request) => {
  const token = request.headers.get("authorization");
  if (token === "Bearer held") return Response.json({ error: "Account held" }, { status: 403 });
  if (token === "Bearer owner") return { org: { id: "owner-org" } };
  if (token === "Bearer foreign") return { org: { id: "other-org" } };
  return null;
} }));

const { saveReviewAttempt } = await import("../../review-attempt");
const { unknownReviewCoverage } = await import("../../review-coverage");
const { GET } = await import("../../../app/api/review-attempts/[id]/route");
const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const coverage = { ...unknownReviewCoverage("github", "fixture"), headSha: currentHead };
await saveReviewAttempt(first, "pr", coverage, "First immutable report");
await saveReviewAttempt(second, "pr", coverage, "Second immutable report");
assert.equal(rows.size, 2);
assert.equal(rows.get(first)?.reviewBody, "First immutable report");
assert.equal(current.reviewBody, "Second immutable report");
await assert.rejects(saveReviewAttempt(first, "pr", coverage, "overwrite"), /duplicate/);
assert.equal(rows.get(first)?.reviewBody, "First immutable report");
const request = (headers: Record<string, string>) => GET(new Request("https://example.test/api/review-attempts/" + first, { headers }), { params: Promise.resolve({ id: first }) });
assert.equal((await request({})).status, 401);
assert.equal(queries, 0);
assert.equal((await request({ authorization: "Bearer foreign" })).status, 404);
assert.equal((await request({ authorization: "Bearer invalid", "x-user": "alice" })).status, 401);
assert.equal((await request({ authorization: "Bearer held" })).status, 403);
const authorized = await request({ authorization: "Bearer owner" });
assert.equal(authorized.status, 200);
assert.equal((await authorized.json()).reviewBody, "First immutable report");
assert.equal(authorized.headers.get("cache-control"), "private, no-store");
assert.equal((await request({ "x-user": "bob" })).status, 404);
assert.equal((await request({ "x-user": "alice" })).status, 200);
member = false;
assert.equal((await request({ "x-user": "alice" })).status, 404);
currentHead = "b".repeat(40);
await saveReviewAttempt("33333333-3333-4333-8333-333333333333", "pr", { ...coverage, headSha: "a".repeat(40) }, "Old-head report");
assert.equal(rows.size, 3);
assert.equal(current.reviewBody, "Second immutable report");
await saveReviewAttempt("44444444-4444-4444-8444-444444444444", "pr", { ...coverage, headSha: currentHead }, "New-head report");
await saveReviewAttempt("55555555-5555-4555-8555-555555555555", "pr", unknownReviewCoverage("github", "legacy"), "Unknown-head report");
await saveReviewAttempt("66666666-6666-4666-8666-666666666666", "pr", coverage, "Late old-head report");
assert.equal(rows.size, 6);
assert.equal(current.reviewBody, "New-head report");
assert.equal(rows.get("55555555-5555-4555-8555-555555555555")?.reviewBody, "Unknown-head report");
console.log("PASS stale-head isolation, immutable attempts, token/session tenant isolation, account hold and cache policy");

const checks: unknown[][] = [];
const unexpectedPublication = () => { throw new Error("Delayed result published to current PR"); };
mock.module("@/lib/github", () => ({
  updateCheckRun: async (...args: unknown[]) => { checks.push(args); },
  createPullRequestComment: unexpectedPublication,
  updatePullRequestComment: unexpectedPublication,
  createPullRequestReview: unexpectedPublication,
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: unexpectedPublication } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: unexpectedPublication } }));
const { handleLargeReviewResult } = await import("../../large-review-result");
const origin = { attemptId: "77777777-7777-4777-8777-777777777777", headSha: "a".repeat(40), baseSha: "c".repeat(40), checkRunId: 17 };
await handleLargeReviewResult(JSON.parse(JSON.stringify({ pullRequestId: "pr", ...origin, reviewBody: "Overall 5/5" })));
assert.equal(checks.length, 1);
assert.equal(checks[0][3], 17);
assert.equal(checks[0][4], "failure");
assert.equal(rows.get(origin.attemptId)?.headSha, origin.headSha);
assert.equal(rows.get(origin.attemptId)?.baseSha, origin.baseSha);
assert.equal((rows.get(origin.attemptId)?.coverage as { nativeCheckId: string }).nativeCheckId, "17");
assert.equal(current.reviewBody, "New-head report");
await handleLargeReviewResult({ pullRequestId: "pr", reviewBody: "Overall 5/5", checkRunId: 99 });
await handleLargeReviewResult({ pullRequestId: "pr", reviewBody: "", error: "legacy error", checkRunId: 99 });
assert.equal(checks.length, 1);
assert.equal(current.reviewBody, "New-head report");
assert.equal([...rows.values()].slice(-2).every(row => row.headSha === null && !(row.coverage as { complete: boolean }).complete), true);
console.log("PASS originating large-review check and revision correlation, legacy result isolation");
