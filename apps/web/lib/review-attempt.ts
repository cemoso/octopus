import "server-only";
import { isReviewRequestVersion } from "@/lib/review-status-state";
import { isDeepStrictEqual } from "node:util";
import { prisma, type Prisma } from "@octopus/db";
import type { ReviewCoverage } from "@/lib/review-coverage";

export async function updateCurrentReview(pullRequestId: string, headSha: string | null, reviewRequestVersion: number | undefined, data: Prisma.PullRequestUpdateManyMutationInput, expectedReviewBody?: string) {
  if (!headSha || !isReviewRequestVersion(reviewRequestVersion)) return { count: 0 };
  return prisma.pullRequest.updateMany({ where: { id: pullRequestId, headSha, reviewRequestVersion, ...(expectedReviewBody !== undefined ? { reviewBody: expectedReviewBody } : {}) }, data });
}

export async function createReviewAttemptComment(
  pullRequestId: string,
  headSha: string | null,
  reviewRequestVersion: number | undefined,
  create: () => Promise<number>,
  expectedReviewBody?: string,
): Promise<number> {
  const id = await create();
  await updateCurrentReview(pullRequestId, headSha, reviewRequestVersion, { reviewCommentId: id }, expectedReviewBody);
  return id;
}

export async function hasReviewAttempt(attemptId: string, pullRequestId: string, coverage: ReviewCoverage, reviewBody: string, client: Pick<Prisma.TransactionClient, "reviewAttempt"> = prisma) {
  const existing = await client.reviewAttempt.findUnique({ where: { id: attemptId } });
  if (!existing) return false;
  if (existing.pullRequestId !== pullRequestId || existing.headSha !== coverage.headSha || existing.baseSha !== coverage.baseSha
    || existing.reviewBody !== reviewBody || !isDeepStrictEqual(existing.coverage, JSON.parse(JSON.stringify(coverage)))) {
    throw new Error("Review attempt identity conflict");
  }
  return true;
}

/** Store a new immutable result and the current PR view atomically. */
export async function saveReviewAttempt(
  attemptId: string,
  pullRequestId: string,
  coverage: ReviewCoverage,
  reviewBody: string,
  issues?: Prisma.ReviewIssueCreateManyInput[],
) {
  const coverageJson = JSON.parse(JSON.stringify(coverage)) as Prisma.InputJsonValue;
  return prisma.$transaction(async tx => {
    const inserted = await tx.reviewAttempt.createMany({ skipDuplicates: true, data: [{
      id: attemptId, pullRequestId, headSha: coverage.headSha,
      baseSha: coverage.baseSha, coverage: coverageJson, reviewBody,
    }] });
    if (!inserted.count) {
      if (!await hasReviewAttempt(attemptId, pullRequestId, coverage, reviewBody, tx)) throw new Error("Review attempt identity conflict");
      return false;
    }
    if (!coverage.headSha || !isReviewRequestVersion(coverage.reviewRequestVersion)) return false;
    const promoted = await tx.pullRequest.updateMany({ where: { id: pullRequestId, headSha: coverage.headSha, reviewRequestVersion: coverage.reviewRequestVersion }, data: {
      status: "completed", reviewBody, reviewCoverage: coverageJson, errorMessage: null,
    } });
    if (!promoted.count) return false;
    if (issues !== undefined) {
      await tx.reviewIssue.deleteMany({ where: { pullRequestId } });
      if (issues.length) await tx.reviewIssue.createMany({ data: issues });
    }
    return true;
  });
}
