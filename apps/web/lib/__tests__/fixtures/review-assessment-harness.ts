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
const { executeCoveredReview, executeFindingsRecovery, recordNoModelAssessment } = await import("../../review-assessment");
const { prepareReviewInput, applyReviewCoverage, renderReviewCoverage, reviewCheckResult, sha256 } = await import("../../review-coverage");
const { createCoveredReviewRequest } = await import("../../review-request");
const { saveReviewAttempt } = await import("../../review-attempt");
const { stripDetailedFindings } = await import("../../review-helpers");
const { prepareReviewPresentation, finalizeReviewPresentation, enforceReviewFindingsIntegrity, mapReviewPresentation } = await import("../../review-presentation");
const { parseFindingsFromJson } = await import("../../review-dedup");
const { updatePullRequestComment, MAX_GITHUB_COMMENT_BODY } = await import("../../github");
let published: { body: string };
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  assert.equal(String(url), "https://api.github.com/repos/fixture/review/issues/comments/123");
  assert.equal(init?.method, "PATCH");
  published = JSON.parse(String(init?.body));
  return Response.json({ id: 123 });
}) as typeof fetch;
const summaryHeader = "| Severity | Count |\n| --- | --- |";
const zeroSummary = `${summaryHeader}\n| 🔴 Critical | 0 |\n| 🟠 High | 0 |\n| 🟡 Medium | 0 |\n| 🔵 Low | 0 |\n| 💡 Nit | 0 |`;
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
${zeroSummary}

### Findings
<!-- OCTOPUS_FINDINGS_START -->
[]
<!-- OCTOPUS_FINDINGS_END -->

Last reviewed commit: ${"a".repeat(40)}
`;
const finding = { severity: "🔴", title: "Missing validation", filePath: "src/validator.ts", startLine: 1, description: "The value needs validation." };
const withFinding = valid.replace(zeroSummary, "| Severity | Count |\n| --- | --- |\n| 🔴 Critical | 1 |").replace("[]", JSON.stringify([finding]));
const fenced = (text: string) => text.replace(/(<!-- OCTOPUS_FINDINGS_START -->\n)([\s\S]*?)(\n<!-- OCTOPUS_FINDINGS_END -->)/, '$1```json\n$2\n```$3');
function plan(oversized = false) {
  const result = prepareReviewInput({ provider: "github", headSha: "a".repeat(40), baseSha: "b".repeat(40), inventoryComplete: true, expectedFiles: oversized ? 100 : 1, limitations: [], files: Array.from({ length: oversized ? 100 : 1 }, (_, i) => ({ path: oversized ? `src/${i}-${"&".repeat(230)}.ts` : "src/validator.ts", change: "added", patch: "@@ -0,0 +1 @@\n+export const valid = true;\n", additions: 1, deletions: 0 })) }, { maxChars: 300000 });
  result.coverage.reviewRequestVersion = 1;
  return result;
}
const requestFor = (p: ReturnType<typeof plan>, model = "gpt-test"): AiCreateParams => createCoveredReviewRequest({ model, system: "Trusted review template", number: 1, title: "Validators", author: "fixture", diff: p.diff, coverage: p.coverage, comment: "@octopus context", repoConfig: "" });
for (const [name, text, finish, complete] of [
  ["valid", valid, "stop", true],
  ["rereview-valid", valid, "stop", true],
  ["critical-empty-diagram", withFinding.replace("### Findings\n", "### Diagram\n\n").replace("**4/5**", "**3/5**"), "stop", true],
  ["critical-fence-description", withFinding.replace(JSON.stringify([finding]), JSON.stringify([{ ...finding, description: "Broken ```### Checklist and ```mermaid\nsequenceDiagram\nactivate missing\n``` inside the finding" }])), "stop", true],
  ["turkish-zero", valid.replace("The changed validator is consistent with its documented contract.", "Sorun bulunamadı. Değişiklik belgelenen sözleşmeyle uyumlu."), "stop", true],
  ["zero-empty-table", valid.replace(zeroSummary, summaryHeader), "stop", true],
  ["english-contradictory-prose", valid.replace(zeroSummary, "1 critical issue found."), "stop", false],
  ["turkish-contradictory-prose", valid.replace(zeroSummary, "1 kritik sorun bulundu."), "stop", false],
  ["english-zero-prose", valid.replace(zeroSummary, "No issues found."), "stop", false],
  ["turkish-zero-prose", valid.replace(zeroSummary, "Sorun bulunamadı."), "stop", false],
  ["missing-summary-header", valid.replace(summaryHeader, ""), "stop", false],
  ["missing-summary-separator", valid.replace("| --- | --- |\n", ""), "stop", false],
  ["duplicate-summary-header", valid.replace(zeroSummary, summaryHeader + "\n" + zeroSummary), "stop", false],
  ["zero-count-with-finding", valid.replace("[]", JSON.stringify([finding])), "stop", false],
  ["empty-table-with-finding", valid.replace(zeroSummary, summaryHeader).replace("[]", JSON.stringify([finding])), "stop", false],
  ["turkish-contradiction", withFinding.replace(JSON.stringify([finding]), "[]").replace("Critical", "Kritik"), "stop", false],
  ["turkish-prose-and-count", valid.replace(zeroSummary, "Sorun bulunamadı.\n| 🔴 Kritik | 1 |"), "stop", false],
  ["turkish-wrong-severity", withFinding.replace("🔴 Critical", "🟠 Yüksek"), "stop", false],
  ["oversized-valid", valid.replace("The changed validator is consistent with its documented contract.", "Uzun açıklama 🔴 ".repeat(10000)), "stop", true],
  ["oversized-rereview", valid.replace("The changed validator is consistent with its documented contract.", "Uzun açıklama 🔴 ".repeat(10000)), "stop", true],
  ["oversized-incomplete", valid.replace("The changed validator is consistent with its documented contract.", "Uzun açıklama 🔴 ".repeat(10000)), "length", false],
  ["oversized-score-notes", valid.replace("Lowest category", "Uzun not 🔴 ".repeat(10000)), "stop", true],
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
  const oversized = name.startsWith("oversized-");
  const p = plan(oversized);
  output = { choices: [{ message: { content: text }, finish_reason: finish }] };
  await executeCoveredReview(requestFor(p), p.coverage, "template-v1", request => openaiProvider.create(request, "fake"));
  assert.equal(p.coverage.complete, complete, name);
  assert.equal(p.coverage.assessment?.responseSha256, sha256(text));
  assert.equal(p.coverage.assessment?.requests[0].sha256, createHash("sha256").update(JSON.stringify(received)).digest("hex"));
  const prepared = prepareReviewPresentation(text, p.coverage);
  const findings = parseFindingsFromJson(prepared) ?? [];
  assert.deepEqual(findings, parseFindingsFromJson(text) ?? [], name);
  const flags = { hasCritical: findings.some(f => f.severity === "🔴"), hasHigh: findings.some(f => f.severity === "🟠"), hasMedium: findings.some(f => f.severity === "🟡") };
  const covered = applyReviewCoverage(prepared, p.coverage, name);
  const { report, comment } = finalizeReviewPresentation(text, covered, stripDetailedFindings(covered), p.coverage, name, flags);
  await saveReviewAttempt(name, "pr", p.coverage, report);
  assert.equal((current.reviewCoverage as typeof p.coverage).complete, complete);
  // reviewer.ts places this fixed banner between its attempt label and coverage
  // on a completed re-review with zero new findings.
  const rereviewBanner = name.includes("rereview") ? `> ✅ No new issues detected since the last review (commit \`${p.coverage.headSha!.slice(0, 7)}\`).\n\n` : "";
  await updatePullRequestComment(1, "fixture", "review", 123, `Review attempt: ${name}. Head: ${p.coverage.headSha}.\n\n${rereviewBanner}${comment}`, "fixture-token");
  const nativeCheck = { id: 456, head_sha: p.coverage.headSha, app: { slug: "octopus-review" }, status: "completed", ...reviewCheckResult(p.coverage, flags.hasCritical, findings.length) };
  assert.equal(nativeCheck.conclusion, complete && !flags.hasCritical ? "success" : "failure");
  assert.equal(rows.get(name)?.reviewBody, report);
  const attemptUrl = new URL(`/api/review-attempts/${name}`, process.env.NEXT_PUBLIC_APP_URL ?? "https://octopus-review.ai").href;
  const reference = `Attempt: ${name} ${attemptUrl}.\nHead: \`${p.coverage.headSha}\`. Base: \`${p.coverage.baseSha}\`.`;
  for (const body of [report, published!.body]) {
    assert.ok(body.includes(reference), `${name}: attempt and revision metadata retained`);
    assert.ok(!/<\/?(?:details|summary)>|Attempt: \[/.test(body), `${name}: plain Markdown coverage`);
  }
  assert.ok(report.includes(`#### Changed-file coverage (${p.coverage.files.length} known paths)`));
  if (complete) assert.equal(report.match(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/)?.[0], text.match(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/)?.[0]);
  if (oversized) {
    assert.ok(comment.length > MAX_GITHUB_COMMENT_BODY);
    assert.ok(published!.body.length <= MAX_GITHUB_COMMENT_BODY);
    assert.ok(published!.body.includes("Comment truncated"));
    assert.ok(published!.body.includes(`/api/review-attempts/${name}`));
    assert.ok(published!.body.startsWith(`Review attempt: ${name}. Head: ${p.coverage.headSha}.`));
    assert.ok(published!.body.isWellFormed());
    assert.equal((rows.get(name)!.coverage as typeof p.coverage).files.length, 100);
    assert.ok(renderReviewCoverage(p.coverage, name).length < 14_000);
    assert.ok(renderReviewCoverage(p.coverage, name).includes("The full inventory is stored"));
  } else {
    assert.equal(published!.body, `Review attempt: ${name}. Head: ${p.coverage.headSha}.\n\n${rereviewBanner}${comment}`);
  }
  assert.ok(!published!.body.includes("OCTOPUS_FINDINGS_"));
  for (const body of [report, published!.body]) {
    assert.equal((body.match(/Last reviewed commit:/g) ?? []).length, 1);
    assert.ok(body.endsWith(`Last reviewed commit: ${p.coverage.headSha}`));
  }
  if (!complete) {
    assert.ok(!/Overall[^\n]*[1-5]\/5/.test(report), name);
    assert.ok(!/Overall[^\n]*[1-5]\/5/.test(published!.body), name);
    assert.ok(published!.body.includes("not assessed"), name);
    assert.ok(published!.body.includes(p.coverage.assessment!.reason), name);
    if (oversized) assert.ok(!/\|[^\n]*[1-5]\/5/.test(published!.body), name);
  } else {
    assert.equal((published!.body.match(/^## 🐙 Octopus Review$/gm) ?? []).length, 1);
    assert.equal((published!.body.match(/^### Score$/gm) ?? []).length, 1);
    assert.ok(published!.body.includes(`| **Overall** | **${name === "critical-empty-diagram" ? 3 : 4}/5**`), name);
    assert.equal((report.match(/Last reviewed commit: a{40}/g) ?? []).length, 1);
  }
  if (process.env.REVIEW_TEST_EVIDENCE_DIR) {
    await Bun.write(`${process.env.REVIEW_TEST_EVIDENCE_DIR}/assessment-${name}.json`, JSON.stringify({ sourceRevision: process.env.REVIEW_TEST_SOURCE_REVISION ?? null, sourceDiffSha256: process.env.REVIEW_TEST_DIFF_SHA256 ?? null, request: received, coverage: p.coverage, report, publishedComment: published!.body, current, nativeCheck }, null, 2));
  }
  assert.equal(await saveReviewAttempt(name, "pr", p.coverage, report), false);
  const changed = structuredClone(p.coverage);
  changed.assessment!.requests[0].sha256 = "f".repeat(64);
  await assert.rejects(saveReviewAttempt(name, "pr", changed, report), /identity conflict/);
}
for (const corruption of ["lost", "changed", "summary"] as const) {
  const p = plan();
  output = { choices: [{ message: { content: withFinding }, finish_reason: "stop" }] };
  await executeCoveredReview(requestFor(p), p.coverage, "v1", request => openaiProvider.create(request, "fake"));
  let damaged = prepareReviewPresentation(withFinding, p.coverage);
  if (corruption === "lost") damaged = stripDetailedFindings(damaged);
  if (corruption === "changed") damaged = damaged.replace(JSON.stringify([finding]), "[]");
  if (corruption === "summary") damaged = damaged.replace("| 🔴 Critical | 1 |", "| 🔴 Critical | 0 |");
  if (corruption === "summary") enforceReviewFindingsIntegrity(withFinding, damaged, p.coverage, true);
  const result = finalizeReviewPresentation(withFinding, damaged, stripDetailedFindings(damaged), p.coverage, corruption, { hasCritical: false, hasHigh: false, hasMedium: false });
  assert.equal(p.coverage.complete, false);
  await saveReviewAttempt(corruption, "pr", p.coverage, result.report);
  await updatePullRequestComment(1, "fixture", "review", 123, result.comment, "fixture-token");
  assert.ok(published!.body.includes("not assessed"));
  assert.ok(!/Overall[^\n]*[1-5]\/5/.test(published!.body));
  assert.equal(reviewCheckResult(p.coverage, false, 0).conclusion, "failure");
}
for (const scenario of ["partial-completed", "partial-oversized", "partial-corrupted"] as const) {
  const input = { provider: "github" as const, headSha: "a".repeat(40), baseSha: "b".repeat(40), inventoryComplete: true, expectedFiles: 1, limitations: [], files: [{ path: "src/validator.ts", change: "modified", patch: "@@ -0,0 +1 @@\n+one\n@@ -4,0 +5 @@\n+two\n" }] };
  const full = prepareReviewInput(input, { maxChars: 1000 });
  const p = prepareReviewInput(input, { maxChars: full.diff.length - 1 });
  p.coverage.reviewRequestVersion = 1;
  assert.equal(p.coverage.files[0].state, "partial");
  assert.equal(p.coverage.files[0].hunks.length, 1);
  const response = scenario === "partial-oversized" ? valid.replace("The changed validator is consistent with its documented contract.", "Subset commentary 🔴 ".repeat(10000)) : valid;
  output = { choices: [{ message: { content: response }, finish_reason: "stop" }] };
  await executeCoveredReview(requestFor(p), p.coverage, "v1", request => openaiProvider.create(request, "fake"));
  const completionEvidence = structuredClone(p.coverage.assessment);
  assert.equal(completionEvidence?.state, "completed");
  assert.equal(p.coverage.complete, false);
  let report = applyReviewCoverage(prepareReviewPresentation(response, p.coverage), p.coverage, scenario);
  if (scenario === "partial-corrupted") report = report.replace("[]", JSON.stringify([finding]));
  enforceReviewFindingsIntegrity(response, report, p.coverage, true);
  const result = finalizeReviewPresentation(response, report, stripDetailedFindings(report), p.coverage, scenario, { hasCritical: false, hasHigh: false, hasMedium: false });
  await saveReviewAttempt(scenario, "pr", p.coverage, result.report);
  await updatePullRequestComment(1, "fixture", "review", 123, `Review attempt: ${scenario}. Head: ${p.coverage.headSha}.\n\n${result.comment}`, "fixture-token");
  const stored = rows.get(scenario)!.coverage as typeof p.coverage;
  assert.equal(stored.complete, false);
  assert.equal(stored.assessment?.responseSha256, completionEvidence?.responseSha256);
  assert.deepEqual(stored.assessment?.completion, completionEvidence?.completion);
  if (scenario === "partial-corrupted") {
    assert.equal(stored.assessment?.state, "incomplete");
    assert.match(stored.assessment!.reason, /lost, changed or inconsistent/);
  } else {
    assert.deepEqual(stored.assessment, completionEvidence);
    assert.ok(!published!.body.includes("lost, changed or inconsistent"));
  }
  assert.ok(published!.body.includes(stored.assessment!.reason));
  assert.ok(published!.body.includes("not assessed"));
  assert.ok(!/Overall[^\n]*[1-5]\/5/.test(published!.body));
  assert.ok(!/Overall[^\n]*[1-5]\/5/.test(result.report));
  assert.ok(published!.body.endsWith(`Last reviewed commit: ${p.coverage.headSha}`));
  const nativeCheck = { id: 456, head_sha: p.coverage.headSha, app: { slug: "octopus-review" }, status: "completed", ...reviewCheckResult(p.coverage, false, 0) };
  assert.equal(nativeCheck.conclusion, "failure");
  if (scenario === "partial-oversized") {
    assert.ok(published!.body.includes("Comment truncated"));
    assert.ok(published!.body.length <= MAX_GITHUB_COMMENT_BODY);
    assert.ok(!/\|[^\n]*[1-5]\/5/.test(published!.body));
  }
  if (process.env.REVIEW_TEST_EVIDENCE_DIR) {
    await Bun.write(`${process.env.REVIEW_TEST_EVIDENCE_DIR}/assessment-${scenario}.json`, JSON.stringify({ sourceRevision: process.env.REVIEW_TEST_SOURCE_REVISION ?? null, sourceDiffSha256: process.env.REVIEW_TEST_DIFF_SHA256 ?? null, request: received, coverage: p.coverage, report: result.report, publishedComment: published!.body, nativeCheck }, null, 2));
  }
}
const filtered = plan();
output = { choices: [{ message: { content: withFinding }, finish_reason: "stop" }] };
await executeCoveredReview(requestFor(filtered), filtered.coverage, "v1", request => openaiProvider.create(request, "fake"));
const preparedForFilter = prepareReviewPresentation(withFinding, filtered.coverage);
enforceReviewFindingsIntegrity(withFinding, preparedForFilter, filtered.coverage, true);
const policyPresentation = mapReviewPresentation(preparedForFilter, body => body.replace("| 🔴 Critical | 1 |", "Filtered by existing policy."));
const filteredResult = finalizeReviewPresentation(withFinding, policyPresentation, stripDetailedFindings(policyPresentation), filtered.coverage, "filtered", { hasCritical: false, hasHigh: false, hasMedium: false });
assert.equal(filtered.coverage.complete, true);
assert.deepEqual(parseFindingsFromJson(filteredResult.report), parseFindingsFromJson(withFinding));
const interruptedPlan = plan(); interrupted = true;
await assert.rejects(executeCoveredReview(requestFor(interruptedPlan), interruptedPlan.coverage, "v1", request => openaiProvider.create(request, "fake")), /interrupted/);
assert.equal(interruptedPlan.coverage.complete, false);
assert.equal(interruptedPlan.coverage.assessment?.requests.length, 1);
assert.equal(interruptedPlan.coverage.assessment?.responseSha256, null);
interrupted = false;

// Exercise the same recovery request boundary used by the reviewer, including
// the adapter's final SDK payload and immutable persistence of its provenance.
const malformedReview = withFinding.replace(JSON.stringify([finding]), "[]");
for (const [name, finish, outcome] of [
  ["completed", "stop", "completed"],
  ["length", "length", "incomplete"],
  ["unknown", null, "incomplete"],
  ["interrupted", "stop", "failed"],
  ["unobserved", "stop", "incomplete"],
] as const) {
  const p = plan();
  output = { choices: [{ message: { content: malformedReview }, finish_reason: "stop" }] };
  await executeCoveredReview(requestFor(p), p.coverage, "v1", request => openaiProvider.create(request, "fake"));
  const primary = structuredClone(p.coverage.assessment!);
  assert.equal(primary.state, "incomplete");
  output = { choices: [{ message: { content: JSON.stringify([finding]) }, finish_reason: finish }] };
  interrupted = name === "interrupted";
  const recover = (reviewBody = malformedReview) => executeFindingsRecovery({ model: "gpt-test", reviewBody, parsedFindingsCount: 0, tableFindingsTotal: 1 }, p.coverage, request => {
    // An uninstrumented adapter must remain explicitly unobserved.
    return openaiProvider.create(name === "unobserved" ? { ...request, onRequest: undefined } : request, "fake");
  });
  if (interrupted) await assert.rejects(recover(), /interrupted/);
  else assert.equal((await recover()).text, JSON.stringify([finding]));
  interrupted = false;
  const recovery = p.coverage.assessment!.recoveries![0];
  const primaryAfter = { ...p.coverage.assessment! };
  delete primaryAfter.recoveries;
  assert.deepEqual(primaryAfter, primary, `${name}: recovery must not rewrite the primary assessment`);
  assert.equal(p.coverage.complete, false);
  assert.equal(recovery.state, outcome, name);
  assert.equal(recovery.model, "gpt-test");
  assert.equal(recovery.responseModel, name === "interrupted" ? null : "gpt-test");
  assert.equal(recovery.responseProvider, name === "interrupted" ? null : "openai");
  assert.equal(recovery.requests.length, name === "unobserved" ? 0 : 1);
  if (name !== "unobserved") {
    assert.equal(recovery.requests[0].sha256, sha256(JSON.stringify(received)));
    assert.equal(recovery.requests[0].inputPreserved, true);
  }
  assert.equal(recovery.responseSha256, name === "interrupted" ? null : sha256(JSON.stringify([finding])));
  assert.deepEqual(recovery.completion, name === "interrupted" ? null : completionEvidence(finish, ["stop"]));
  assert.match(recovery.policySha256, /^[a-f0-9]{64}$/);
  assert.match(recovery.templateSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(recovery).includes("Missing validation"));
  const report = applyReviewCoverage(malformedReview, p.coverage, `recovery-${name}`);
  await saveReviewAttempt(`recovery-${name}`, "pr", p.coverage, report);
  assert.equal(await saveReviewAttempt(`recovery-${name}`, "pr", structuredClone(p.coverage), report), false);
  assert.equal(reviewCheckResult(p.coverage, false, 0).conclusion, "failure");
  for (const mutation of ["policy", "outcome", "response"] as const) {
    const changed = structuredClone(p.coverage);
    const evidence = changed.assessment!.recoveries![0];
    if (mutation === "policy") evidence.policySha256 = sha256("different recovery policy");
    if (mutation === "outcome") evidence.state = outcome === "completed" ? "incomplete" : "completed";
    if (mutation === "response") evidence.responseSha256 = sha256("different recovery output");
    await assert.rejects(saveReviewAttempt(`recovery-${name}`, "pr", changed, report), /identity conflict/);
  }
  if (name === "completed") {
    const original = structuredClone(p.coverage);
    p.coverage.assessment = structuredClone(primary);
    await recover(malformedReview + "\nAdditional recovery input");
    assert.notEqual(p.coverage.assessment.recoveries![0].requests[0].sha256, recovery.requests[0].sha256);
    await assert.rejects(saveReviewAttempt(`recovery-${name}`, "pr", p.coverage, report), /identity conflict/);
    p.coverage.assessment = { ...structuredClone(primary), policySha256: sha256("changed repository policy") };
    await recover();
    assert.notEqual(p.coverage.assessment.recoveries![0].policySha256, recovery.policySha256);
    await assert.rejects(saveReviewAttempt(`recovery-${name}`, "pr", p.coverage, report), /identity conflict/);
    p.coverage.assessment = structuredClone(primary);
    await recover();
    assert.deepEqual(p.coverage, original);
    assert.equal(await saveReviewAttempt(`recovery-${name}`, "pr", p.coverage, report), false);
    p.coverage.assessment = structuredClone(primary);
    output = { choices: [{ message: { content: JSON.stringify([finding]) }, finish_reason: "length" }] };
    await recover();
    assert.equal(p.coverage.assessment.recoveries![0].requests[0].sha256, recovery.requests[0].sha256);
    assert.equal(p.coverage.assessment.recoveries![0].responseSha256, recovery.responseSha256);
    assert.equal(p.coverage.assessment.recoveries![0].state, "incomplete");
    await assert.rejects(saveReviewAttempt(`recovery-${name}`, "pr", p.coverage, report), /identity conflict/);
  }
}

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
