import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import type { ReviewCoverage } from "@/lib/review-coverage";

export async function updateCurrentReview(pullRequestId: string, headSha: string | null, data: Prisma.PullRequestUpdateManyMutationInput) {
  if (!headSha) return { count: 0 };
  return prisma.pullRequest.updateMany({ where: { id: pullRequestId, headSha }, data });
}

export async function createReviewAttemptComment(
  pullRequestId: string,
  headSha: string | null,
  create: () => Promise<number>,
): Promise<number> {
  const id = await create();
  await updateCurrentReview(pullRequestId, headSha, { reviewCommentId: id });
  return id;
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
    await tx.reviewAttempt.create({ data: {
      id: attemptId, pullRequestId, headSha: coverage.headSha,
      baseSha: coverage.baseSha, coverage: coverageJson, reviewBody,
    } });
    if (!coverage.headSha) return false;
    const promoted = await tx.pullRequest.updateMany({ where: { id: pullRequestId, headSha: coverage.headSha }, data: {
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
