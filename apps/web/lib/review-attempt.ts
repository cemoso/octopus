import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import type { ReviewCoverage } from "@/lib/review-coverage";

/** Store a new immutable result and the current PR view atomically. */
export async function saveReviewAttempt(attemptId: string, pullRequestId: string, coverage: ReviewCoverage, reviewBody: string) {
  const coverageJson = JSON.parse(JSON.stringify(coverage)) as Prisma.InputJsonValue;
  await prisma.$transaction([
    prisma.reviewAttempt.create({ data: {
      id: attemptId, pullRequestId, headSha: coverage.headSha,
      baseSha: coverage.baseSha, coverage: coverageJson, reviewBody,
    } }),
    ...(coverage.headSha ? [prisma.pullRequest.updateMany({ where: { id: pullRequestId, headSha: coverage.headSha }, data: {
      status: "completed", reviewBody, reviewCoverage: coverageJson, errorMessage: null,
    } })] : []),
  ]);
}
