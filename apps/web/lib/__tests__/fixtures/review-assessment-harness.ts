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

### Findings
<!-- OCTOPUS_FINDINGS_START -->
[]
<!-- OCTOPUS_FINDINGS_END -->

Last reviewed commit: ${"a".repeat(40)}
`;
function plan() {
  const result = prepareReviewInput({ provider: "github", headSha: "a".repeat(40), baseSha: "b".repeat(40), inventoryComplete: true, expectedFiles: 1, limitations: [], files: [{ path: "src/validator.ts", change: "added", patch: "@@ -0,0 +1 @@\n+export const valid = true;\n", additions: 1, deletions: 0 }] }, { maxChars: 300000 });
  result.coverage.reviewRequestVersion = 1;
  return result;
}
const requestFor = (p: ReturnType<typeof plan>, model = "gpt-test"): AiCreateParams => createCoveredReviewRequest({ model, system: "Trusted review template", number: 1, title: "Validators", author: "fixture", diff: p.diff, coverage: p.coverage, comment: "@octopus context", repoConfig: "" });
for (const [name, text, finish, complete] of [
  ["valid", valid, "stop", true], ["empty", "", "stop", false],
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
  const report = applyReviewCoverage(text, p.coverage, name);
  await saveReviewAttempt(name, "pr", p.coverage, report);
  assert.equal((current.reviewCoverage as typeof p.coverage).complete, complete);
  assert.equal(reviewCheckResult(p.coverage, false, 0).conclusion, complete ? "success" : "failure");
  if (!complete) assert.ok(!/Overall[^\n]*[1-5]\/5/.test(report), name);
  else {
    assert.equal((report.match(/^## 🐙 Octopus Review$/gm) ?? []).length, 1);
    assert.equal((report.match(/^### Score$/gm) ?? []).length, 1);
    assert.equal((report.match(/\| \*\*Overall\*\* \| \*\*4\/5\*\*/g) ?? []).length, 1);
    assert.equal((report.match(/Last reviewed commit: a{40}/g) ?? []).length, 1);
  }
  if (process.env.REVIEW_TEST_EVIDENCE_DIR) {
    await Bun.write(`${process.env.REVIEW_TEST_EVIDENCE_DIR}/assessment-${name}.json`, JSON.stringify({ request: received, coverage: p.coverage, report, current, nativeCheck: reviewCheckResult(p.coverage, false, 0) }, null, 2));
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
