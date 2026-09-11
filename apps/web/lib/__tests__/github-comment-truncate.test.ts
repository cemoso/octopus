import { describe, it, expect, mock } from "bun:test";
mock.module("server-only", () => ({}));
const { MAX_GITHUB_COMMENT_BODY, truncateForGithubComment, createPullRequestReview, updatePullRequestComment } = await import("@/lib/github");

describe("truncateForGithubComment", () => {
  it("returns short bodies unchanged", () => {
    expect(truncateForGithubComment("hello")).toBe("hello");
    expect(truncateForGithubComment("")).toBe("");
  });

  it("does NOT truncate at the cap boundary", () => {
    const body = "a".repeat(MAX_GITHUB_COMMENT_BODY);
    expect(truncateForGithubComment(body)).toBe(body);
  });

  it("appends a clear truncation marker when over the cap", () => {
    const body = "a".repeat(MAX_GITHUB_COMMENT_BODY + 1000);
    const out = truncateForGithubComment(body);
    expect(out.length).toBeLessThanOrEqual(MAX_GITHUB_COMMENT_BODY);
    expect(out).toContain("Comment truncated");
    expect(out).toContain("GitHub's per-comment size cap");
  });

  it("prefers a paragraph boundary near the cap", () => {
    // Compose a body where the last `\n\n` lies near the limit; the cut
    // should land at that boundary, not mid-line.
    const head = "section one".padEnd(MAX_GITHUB_COMMENT_BODY - 5_000, "x");
    const tail = "section two that wouldn't fit and goes well past the limit";
    const body = head + "\n\n" + tail.repeat(200);
    const out = truncateForGithubComment(body);
    // The marker is the only `\n\n---\n\n` so split on it to find the body content.
    const beforeMarker = out.split("\n\n---\n\n")[0];
    // Body content ends at a \n\n boundary OR is exactly equal to the head.
    // Assert no half-cut tail content (tail starts with "section two").
    expect(beforeMarker.endsWith(head)).toBe(true);
  });

  it("falls back to a hard cut when no recent boundary exists", () => {
    // No newlines at all — must still produce a body that fits.
    const body = "a".repeat(MAX_GITHUB_COMMENT_BODY * 2);
    const out = truncateForGithubComment(body);
    expect(out.length).toBeLessThanOrEqual(MAX_GITHUB_COMMENT_BODY);
    expect(out).toContain("Comment truncated");
  });

  it("does not end on a lone surrogate (would break JSON encode)", () => {
    // 🔴 is a surrogate pair in UTF-16. A body of contiguous 🔴 with no
    // newlines lands in the hard-cut path; without the guard, slice may
    // cut between the high and low surrogate and emit a malformed string.
    // String.prototype.isWellFormed() (ES2024) reports unpaired surrogates.
    const body = "🔴".repeat(MAX_GITHUB_COMMENT_BODY);
    const out = truncateForGithubComment(body);
    expect(out.length).toBeLessThanOrEqual(MAX_GITHUB_COMMENT_BODY);
    expect(out.isWellFormed()).toBe(true);
    // Sanity: re-encoding through JSON preserves all code points.
    expect(() => JSON.parse(JSON.stringify({ body: out }))).not.toThrow();
  });
});

it("preserves exact new and stored legacy attempt references through compact PATCH publication", async () => {
  const head = "a".repeat(40), base = "b".repeat(40);
  const attemptId = "11111111-2222-4333-8444-555555555555";
  const url = `https://octopus-review.ai/api/review-attempts/${attemptId}`;
  const revision = `Head: \`${head}\`. Base: \`${base}\`.`;
  const references = [
    `Attempt: ${attemptId} ${url}.\n${revision}`,
    `Attempt: [\`${attemptId}\`](${url}). ${revision}`,
  ];
  const prefix = `Review attempt: ${attemptId}. Head: ${head}.\n\n`;
  const canonical = `## 🐙 Octopus Review\n\n### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| Overall | 4/5 | Bounded |\n\n### Findings\n${"long explanation ".repeat(6000)}\n\nLast reviewed commit: ${head}`;
  const originalFetch = globalThis.fetch;
  const published: string[] = [];
  globalThis.fetch = (async (request: unknown, init?: RequestInit) => {
    expect(String(request)).toBe("https://api.github.com/repos/fixture/review/issues/comments/123");
    expect(init?.method).toBe("PATCH");
    published.push(JSON.parse(String(init?.body)).body);
    return Response.json({ id: 123 });
  }) as typeof fetch;
  try {
    const banners = ["", "> ✅ No new issues detected since the last review.\n\n", `> ✅ No new issues detected since the last review (commit \`${head.slice(0, 7)}\`).\n\n`];
    for (const reference of references) for (const banner of banners) {
      const body = `${prefix}${banner}### Review coverage\n\n**Review scope complete: 1/1 files fully supplied.**\n\n${reference}\n\nAssessment: Completed fixture.\n\n${canonical}`;
      await updatePullRequestComment(1, "fixture", "review", 123, body, "fixture-token");
      const output = published.at(-1)!;
      expect(output).toContain(reference);
      expect(output).toContain("| Overall | 4/5 | Bounded |");
      expect(output).toContain("Assessment: Completed fixture.");
      expect(output).toContain("Comment truncated");
      expect(output.startsWith(prefix)).toBe(true);
      expect(output.endsWith(`Last reviewed commit: ${head}`)).toBe(true);
      expect(output.length).toBeLessThanOrEqual(MAX_GITHUB_COMMENT_BODY);
    }
    // A finding's arbitrary link or mismatched attempt download is not evidence metadata.
    for (const invalid of [
      `Attempt: [unrelated](https://example.test/unrelated).`,
      references[0].replace(`/api/review-attempts/${attemptId}`, "/api/review-attempts/other-attempt"),
    ]) {
      const body = `${prefix}### Review coverage\n\n**Review scope complete: 1/1 files fully supplied.**\n\n${invalid}\n\nAssessment: Completed fixture.\n\n${canonical}`;
      await updatePullRequestComment(1, "fixture", "review", 123, body, "fixture-token");
      expect(published.at(-1)).not.toContain(invalid);
    }
    const arbitraryPrefix = `${prefix}> An arbitrary finding, not the provider re-review banner.\n\n### Review coverage\n\n**Review scope complete: 1/1 files fully supplied.**\n\n${references[0]}\n\n${canonical}`;
    await updatePullRequestComment(1, "fixture", "review", 123, arbitraryPrefix, "fixture-token");
    expect(published.at(-1)).not.toContain(references[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("pins submitted review records to the originating commit", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 123 });
  }) as typeof fetch;
  try {
    const head = "a".repeat(40);
    expect(await createPullRequestReview(1, "owner", "repo", 2, "Review", "COMMENT", [], "test-only-token", head)).toBe(123);
    expect(requests).toEqual([{ body: "Review", event: "COMMENT", comments: [], commit_id: head }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
