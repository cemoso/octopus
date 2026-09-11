import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AiCreateParams } from "../../providers";

mock.module("server-only", () => ({}));
let output: Record<string, unknown> = {};
let received: unknown;
let interrupted = false;
class FakeOpenAI {
  chat = { completions: { create: async (request: unknown) => {
    received = request;
    if (interrupted) throw new Error("simulated interrupted response");
    return output;
  } } };
  responses = { create: async (request: unknown) => { received = request; return output; } };
}
mock.module("openai", () => ({ default: FakeOpenAI }));
type Row = { id: string; pullRequestId: string; headSha: string; baseSha: string; coverage: unknown; reviewBody: string };
const rows = new Map<string, Row>();
let current: Record<string, unknown> = {};
const db = {
  reviewAttempt: {
    createMany: async ({ data }: { data: Row[] }) => { if (rows.has(data[0].id)) return { count: 0 }; rows.set(data[0].id, structuredClone(data[0])); return { count: 1 }; },
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id),
  },
  pullRequest: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { current = structuredClone(data); return { count: 1 }; } },
};
mock.module("@octopus/db", () => ({ prisma: { ...db, $transaction: (run: (tx: typeof db) => unknown) => run(db) } }));

const { openaiProvider } = await import("../../providers/openai");
const { callOpenAiGateway } = await import("../../providers/openai-gateway");
const { observeAiRequest, completionEvidence } = await import("../../providers/request-evidence");
const { executeCoveredReview, recordNoModelAssessment } = await import("../../review-assessment");
const { prepareReviewInput, applyReviewCoverage, reviewCheckResult, sha256 } = await import("../../review-coverage");
const { createCoveredReviewRequest } = await import("../../review-request");
const { saveReviewAttempt } = await import("../../review-attempt");
const { normalizeLastReviewedCommit, stripDetailedFindings, reconcileScoreTable } = await import("../../review-helpers");
const { parseFindingsFromJson } = await import("../../review-dedup");
const { updatePullRequestComment } = await import("../../github");
let published: { body: string };
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  assert.equal(String(url), "https://api.github.com/repos/fixture/review/issues/comments/123");
  assert.equal(init?.method, "PATCH");
  published = JSON.parse(String(init?.body));
  return Response.json({ id: 123 });
}) as typeof fetch;
const valid = `## 🐙 Octopus Review

### Summary
The changed validator is consistent with its documented contract.

### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 5/5 | No security finding |
| Code Quality | 5/5 | Clear implementation |
| Performance | 4/5 | Bounded work |
| Error Handling | 5/5 | Explicit errors |
| Consistency | 5/5 | Consistent |
| **Overall** | **4/5** | Lowest category |

### Findings Summary
No issues found.

### Findings
<!-- OCTOPUS_FINDINGS_START -->
[]
<!-- OCTOPUS_FINDINGS_END -->

Last reviewed commit: ${"a".repeat(40)}
`;
const finding = { severity: "🔴", title: "Missing validation", filePath: "src/validator.ts", startLine: 1, description: "The value needs validation." };
const withFinding = valid.replace("No issues found.", "| Severity | Count |\n| --- | --- |\n| 🔴 Critical | 1 |").replace("[]", JSON.stringify([finding]));
const fenced = (text: string) => text.replace(/(<!-- OCTOPUS_FINDINGS_START -->\n)([\s\S]*?)(\n<!-- OCTOPUS_FINDINGS_END -->)/, '$1```json\n$2\n```$3');
function plan() {
  const result = prepareReviewInput({ provider: "github", headSha: "a".repeat(40), baseSha: "b".repeat(40), inventoryComplete: true, expectedFiles: 1, limitations: [], files: [{ path: "src/validator.ts", change: "added", patch: "@@ -0,0 +1 @@\n+export const valid = true;\n", additions: 1, deletions: 0 }] }, { maxChars: 300000 });
  result.coverage.reviewRequestVersion = 1;
  return result;
}
const requestFor = (p: ReturnType<typeof plan>, model = "gpt-test"): AiCreateParams => createCoveredReviewRequest({ model, system: "Trusted review template", number: 1, title: "Validators", author: "fixture", diff: p.diff, coverage: p.coverage, comment: "@octopus context", repoConfig: "" });
for (const [name, text, finish, complete] of [
  ["valid", valid, "stop", true],
  ["fenced-empty", fenced(valid), "stop", true],
  ["duplicate-marker", valid + "\n<!-- OCTOPUS_FINDINGS_END -->", "stop", false],
  ["fenced-finding", fenced(withFinding), "stop", true],
  ["plain-finding", withFinding, "stop", true],
  ["summary-missing-finding", withFinding.replace(JSON.stringify([finding]), "[]"), "stop", false],
  ["summary-wrong-severity", withFinding.replace("🔴 Critical", "🟠 High"), "stop", false],
  ["summary-extra-finding", valid.replace("[]", JSON.stringify([finding])), "stop", false],
  ["summary-duplicate-count", withFinding.replace("| 🔴 Critical | 1 |", "| 🔴 Critical | 1 |\n| 🔴 Critical | 1 |"), "stop", false],
  ["fenced-trailing-prose", fenced(valid).replace("\n```\n<!--", "\n```\nextra prose\n<!--"), "stop", false],
  ["fenced-broken", fenced(valid).replace("\n```\n<!--", "\n<!--"), "stop", false],
  ["plain-surrounding-prose", valid.replace("[]", "prose [] prose"), "stop", false],
  ["missing-head", valid.replace(/Last reviewed commit:[^\n]*/, ""), "stop", true],
  ["duplicate-head", valid + "\nLast reviewed commit: wrong\n", "stop", true],
  ["wrong-head", valid.replace("Last reviewed commit: " + "a".repeat(40), "Last reviewed commit: " + "c".repeat(40)), "stop", true],
  ["empty", "", "stop", false],
  ["malformed", "Everything is good. Overall 5/5", "stop", false],
  ["invalid-json", valid.replace("[]", "[null]"), "stop", false],
  ["truncated", valid, "length", false], ["unknown", valid, null, false],
  ["refusal", valid, "content_filter", false],
] as const) {
  const p = plan();
  output = { choices: [{ message: { content: text }, finish_reason: finish }] };
  await executeCoveredReview(requestFor(p), p.coverage, "template-v1", request => openaiProvider.create(request, "fake"));
  assert.equal(p.coverage.complete, complete, name);
  assert.equal(p.coverage.assessment?.responseSha256, sha256(text));
  assert.equal(p.coverage.assessment?.requests[0].sha256, createHash("sha256").update(JSON.stringify(received)).digest("hex"));
  const findings = parseFindingsFromJson(text) ?? [];
  const flags = { hasCritical: findings.some(f => f.severity === "🔴"), hasHigh: findings.some(f => f.severity === "🟠"), hasMedium: findings.some(f => f.severity === "🟡") };
  let report = applyReviewCoverage(normalizeLastReviewedCommit(text, p.coverage.headSha), p.coverage, name);
  let comment = stripDetailedFindings(report);
  if (p.coverage.complete) {
    report = reconcileScoreTable(report, flags);
    comment = reconcileScoreTable(comment, flags);
  }
  report = normalizeLastReviewedCommit(report, p.coverage.headSha);
  comment = normalizeLastReviewedCommit(comment, p.coverage.headSha);
  await saveReviewAttempt(name, "pr", p.coverage, report);
  assert.equal((current.reviewCoverage as typeof p.coverage).complete, complete);
  await updatePullRequestComment(1, "fixture", "review", 123, `Review attempt: ${name}. Head: ${p.coverage.headSha}.\n\n${comment}`, "fixture-token");
  const nativeCheck = { id: 456, head_sha: p.coverage.headSha, app: { slug: "octopus-review" }, status: "completed", ...reviewCheckResult(p.coverage, flags.hasCritical, findings.length) };
  assert.equal(nativeCheck.conclusion, complete && !flags.hasCritical ? "success" : "failure");
  assert.equal(rows.get(name)?.reviewBody, report);
  assert.equal(published!.body, `Review attempt: ${name}. Head: ${p.coverage.headSha}.\n\n${comment}`);
  assert.ok(!published!.body.includes("OCTOPUS_FINDINGS_"));
  for (const body of [report, published!.body]) {
    assert.equal((body.match(/Last reviewed commit:/g) ?? []).length, 1);
    assert.ok(body.endsWith(`Last reviewed commit: ${p.coverage.headSha}`));
  }
  if (!complete) {
    assert.ok(!/Overall[^\n]*[1-5]\/5/.test(report), name);
    assert.ok(!/Overall[^\n]*[1-5]\/5/.test(published!.body), name);
  } else {
    assert.equal((published!.body.match(/^## 🐙 Octopus Review$/gm) ?? []).length, 1);
    assert.equal((published!.body.match(/^### Score$/gm) ?? []).length, 1);
    assert.equal((published!.body.match(/\| \*\*Overall\*\* \| \*\*4\/5\*\*/g) ?? []).length, 1);
    assert.equal((report.match(/Last reviewed commit: a{40}/g) ?? []).length, 1);
  }
  if (process.env.REVIEW_TEST_EVIDENCE_DIR) {
    await Bun.write(`${process.env.REVIEW_TEST_EVIDENCE_DIR}/assessment-${name}.json`, JSON.stringify({ request: received, coverage: p.coverage, report, publishedComment: published!.body, current, nativeCheck }, null, 2));
  }
  assert.equal(await saveReviewAttempt(name, "pr", p.coverage, report), false);
  const changed = structuredClone(p.coverage);
  changed.assessment!.requests[0].sha256 = "f".repeat(64);
  await assert.rejects(saveReviewAttempt(name, "pr", changed, report), /identity conflict/);
}
const interruptedPlan = plan(); interrupted = true;
await assert.rejects(executeCoveredReview(requestFor(interruptedPlan), interruptedPlan.coverage, "v1", request => openaiProvider.create(request, "fake")), /interrupted/);
assert.equal(interruptedPlan.coverage.complete, false);
assert.equal(interruptedPlan.coverage.assessment?.requests.length, 1);
assert.equal(interruptedPlan.coverage.assessment?.responseSha256, null);
interrupted = false;

for (const status of ["completed", "incomplete", undefined]) {
  const p = plan(); output = { status, output_text: valid };
  await executeCoveredReview(requestFor(p, "codex-test"), p.coverage, "v1", request => openaiProvider.create(request, "fake"));
  assert.equal(p.coverage.complete, status === "completed");
}
const gateway = plan(); output = { choices: [{ message: { content: valid }, finish_reason: "stop" }] };
await executeCoveredReview(requestFor(gateway, "acp:model"), gateway.coverage, "v1", request => callOpenAiGateway(request, { name: "acp", modelPrefix: "acp:", apiKey: "fake", baseUrl: "https://example.test" }));
assert.equal((received as { model: string }).model, "model");
assert.equal(gateway.coverage.assessment?.requests[0].sha256, sha256(JSON.stringify(received)));
assert.equal(gateway.coverage.complete, true);
const altered = plan();
await executeCoveredReview({ ...requestFor(altered), system: "Different policy" }, altered.coverage, "v2", request => openaiProvider.create(request, "fake"));
assert.notEqual(altered.coverage.assessment?.requests[0].sha256, gateway.coverage.assessment?.requests[0].sha256);
await assert.rejects(saveReviewAttempt("valid", "pr", altered.coverage, rows.get("valid")!.reviewBody), /identity conflict/);
const dropped = plan();
await executeCoveredReview(requestFor(dropped), dropped.coverage, "v1", async request => {
  observeAiRequest(request, "openai", { model: request.model, messages: [{ role: "user", content: "truncated" }] });
  return { text: valid, provider: "openai", model: request.model, completion: completionEvidence("stop", ["stop"]), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
});
assert.equal(dropped.coverage.complete, false);
assert.equal(dropped.coverage.assessment?.requests[0].inputPreserved, false);
const legacy = plan();
assert.equal(reviewCheckResult(legacy.coverage, false, 0).conclusion, "failure");
const excluded = plan(); excluded.coverage.files[0].state = "excluded";
recordNoModelAssessment(excluded.coverage);
assert.equal(reviewCheckResult(excluded.coverage, false, 0).title, "No eligible changes under repository policy");
assert.ok(!applyReviewCoverage(valid, excluded.coverage, "excluded").includes("**4/5**"));
const empty = plan(); empty.coverage.files = []; empty.coverage.expectedFiles = 0;
recordNoModelAssessment(empty.coverage);
assert.equal(reviewCheckResult(empty.coverage, false, 0).conclusion, "failure");
console.log("PASS adapter completion, publication and immutable request identity");
