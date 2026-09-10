import { describe, expect, it } from "bun:test";
import { applyReviewRequested, applyReviewStatus, type ReviewState } from "@/lib/review-status-state";

const request = (headSha?: string | null) => ({ repoId: "repo", pullRequest: { id: "pr", number: 7, status: "pending", headSha, title: "Review" } });
const status = (headSha?: string | null, value = "completed") => ({ repoId: "repo", pullRequestId: "pr", number: 7, headSha, status: value });

describe("dashboard review revision state", () => {
  it("rejects delayed A completion and progress after B is requested", () => {
    let state = applyReviewRequested({}, request("A"));
    state = applyReviewStatus(state, status("A", "reviewing"));
    expect(state.repo[0].status).toBe("reviewing");
    state = applyReviewRequested(state, request("B"));
    expect(applyReviewStatus(state, status("A"))).toBe(state);
    expect(applyReviewStatus(state, status("A", "reviewing"))).toBe(state);
    expect(applyReviewStatus(state, status("A", "failed"))).toBe(state);
    expect(state.repo[0]).toMatchObject({ headSha: "B", status: "pending" });
    state = applyReviewStatus(state, status("B", "reviewing"));
    expect(state.repo[0].status).toBe("reviewing");
    state = applyReviewStatus(state, status("B"));
    expect(state.repo[0]).toMatchObject({ headSha: "B", status: "completed", title: "Review" });
  });

  it("does not let unknown events overwrite a known review", () => {
    const state = applyReviewRequested({}, request("B"));
    for (const head of [undefined, null, ""]) {
      expect(applyReviewStatus(state, status(head))).toBe(state);
      expect(applyReviewRequested(state, request(head))).toBe(state);
    }
    const unknown = applyReviewRequested({}, request());
    expect(applyReviewStatus(unknown, status())).toBe(unknown);
    expect(applyReviewStatus(unknown, status("A"))).toBe(unknown);
    expect(applyReviewRequested(unknown, request("B")).repo[0].headSha).toBe("B");
  });

  it("matches repository, PR identity and head without changing other state", () => {
    const unrelated = [{ id: "other", number: 7, status: "reviewing", headSha: "B" }];
    const initial: Record<string, ReviewState[]> = { otherRepo: unrelated, repo: [{ id: "pr", number: 7, status: "pending", headSha: "B" }] };
    expect(applyReviewStatus(initial, { ...status("B"), pullRequestId: "wrong" })).toBe(initial);
    expect(applyReviewStatus(initial, { ...status("B"), repoId: "missing" })).toBe(initial);
    expect(applyReviewStatus(initial, { ...status("B"), number: 8 })).toBe(initial);
    const updated = applyReviewStatus(initial, status("B"));
    expect(updated.otherRepo).toBe(unrelated);
    expect(initial.repo[0].status).toBe("pending");
    expect(updated.repo[0].status).toBe("completed");
  });
});
