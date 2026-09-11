import { mock } from "bun:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@octopus/db";

mock.module("server-only", () => ({}));
let userId: string | null = "member";
let bannedAt: Date | null = null;
let mustChangePassword = false;
let deletedMember = false;
let orgBanned = false;
let orgDeleted = false;
let activeRepo = true;
let reads = 0;
const id = "11111111-2222-4333-8444-555555555555";
const report = "## 🐙 Octopus Review\n\n### Score\n\n| Category | Score | Notes |\n| --- | --- | --- |\n| Overall | 4/5 | Saved result |\n\n### Findings\n\nOriginal finding with `a | b`.\n\n<script>alert('secret')</script>\n\n![tracking](https://tracker.invalid/pixel.png)\n\n[unsafe](javascript:alert(1))\n\n```js\nconst x = 1;\n```";
const entries = Array.from({ length: 12 }, (_, i) => ({
  id: i === 0 ? id : `00000000-2222-4333-8444-${String(i).padStart(12, "0")}`,
  headSha: String(i).repeat(40).slice(0, 40), createdAt: new Date(Date.UTC(2026, 8, 11, 21 - i)),
}));
const record = { ...entries[0], baseSha: "b".repeat(40), coverage: { complete: true }, reviewBody: report,
  pullRequest: { number: 42, repository: { fullName: "example/project" }, reviewAttempts: entries },
};
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => userId ? { user: { id: userId } } : null } } }));
mock.module("@octopus/db", () => ({ prisma: {
  user: { findUnique: async () => ({ bannedAt, mustChangePassword }) },
  reviewAttempt: { findFirst: async (query: Prisma.ReviewAttemptFindFirstArgs) => {
    reads++;
    // Simulate real filtering; dropping a scope predicate would expose the row.
    const repository = query.where?.pullRequest?.repository as Prisma.RepositoryWhereInput;
    const organization = repository?.organization as Prisma.OrganizationWhereInput;
    const member = organization?.members?.some;
    if (member && (member.userId !== "member" || (member.deletedAt === null && deletedMember))) return null;
    if (organization?.bannedAt === null && orgBanned) return null;
    if (organization?.deletedAt === null && orgDeleted) return null;
    if (repository?.isActive === true && !activeRepo) return null;
    if (query.where?.id !== id) return null;
    const pr = query.select?.pullRequest as Prisma.PullRequestDefaultArgs;
    const history = pr.select?.reviewAttempts as Prisma.PullRequest$reviewAttemptsArgs;
    assert.ok(typeof history.take === "number" && history.take > 0 && history.take <= 10, "History metadata must be bounded");
    assert.deepEqual(history.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(history.select?.reviewBody, undefined, "Do not fetch every archived body");
    return { ...record, pullRequest: { ...record.pullRequest, reviewAttempts: entries.slice(0, history.take) } };
  } },
} }));
const { loadReviewRecordPage } = await import("../../review-record-page");
const { ReviewRecordView } = await import("../../../components/review-record");
const load = (attemptId = id) => loadReviewRecordPage(attemptId, new Headers());
assert.deepEqual(await load("not-an-id"), { state: "not-found" });
userId = null;
assert.deepEqual(await load(), { state: "signed-out" });
assert.equal(reads, 0);
userId = "member";
bannedAt = new Date();
assert.deepEqual(await load(), { state: "blocked" });
bannedAt = null; mustChangePassword = true;
assert.deepEqual(await load(), { state: "password-change" });
assert.equal(reads, 0);
mustChangePassword = false;
userId = "foreign";
assert.deepEqual(await load(), { state: "not-found" });
userId = "member";
deletedMember = true;
assert.deepEqual(await load(), { state: "not-found" });
deletedMember = false; orgBanned = true;
assert.deepEqual(await load(), { state: "not-found" });
orgBanned = false; orgDeleted = true;
assert.deepEqual(await load(), { state: "not-found" });
orgDeleted = false; activeRepo = false;
assert.deepEqual(await load(), { state: "not-found" });
activeRepo = true;
assert.deepEqual(await load("99999999-2222-4333-8444-555555555555"), { state: "not-found" });
const result = await load();
assert.equal(result.state, "found");
if (result.state !== "found") throw new Error("Expected member access");
const html = renderToStaticMarkup(<ReviewRecordView record={result.record} />);
assert.ok(html.includes("Review history") && html.includes("example/project") && html.includes("PR #42"));
assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
assert.ok(html.includes("11 Sep") && html.includes("2026") && html.includes("UTC"));
assert.ok(html.includes(`/api/review-attempts/${id}?download=1`) && html.includes("Download JSON"));
assert.ok(html.includes(`/review-attempts/${entries[9].id}`));
assert.ok(!html.includes(`/review-attempts/${entries[10].id}`));
assert.ok(html.includes("Original finding") && html.includes("4/5") && html.includes("<table>"));
assert.ok(!html.includes("<script") && !html.includes("<img") && !html.includes("tracker.invalid") && !html.includes('href="javascript:'));
assert.equal(result.record.reviewBody, report, "Rendering preserves the immutable report");
console.log("PASS protected readable review history, bounded metadata, original report and safe Markdown");
