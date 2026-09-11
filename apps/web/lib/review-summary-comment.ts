import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { isReviewRequestVersion } from "@/lib/review-status-state";
import { createPullRequestComment, updatePullRequestComment, getInstallationToken, findPullRequestSummaryComment } from "@/lib/github";

type SummaryTarget = {
  pullRequestId: string;
  headSha: string | null;
  reviewRequestVersion: number | undefined;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  expectedReviewBody?: string;
};

/** Reuse the PR's summary while serializing publication with review admission. */
export async function publishReviewSummary(target: SummaryTarget): Promise<number | null> {
  if (!target.headSha || !isReviewRequestVersion(target.reviewRequestVersion)) return null;
  // Resolve authentication before taking the row lock; provider I/O inside it
  // has a shared deadline shorter than the transaction timeout.
  const token = await getInstallationToken(target.installationId);
  let reservation: number | undefined;
  for (;;) {
    let creationAttempted = false;
    let creationRejected = false;
    try {
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const signal = AbortSignal.timeout(10_000);
        const [current] = await tx.$queryRaw<{
          headSha: string | null; reviewRequestVersion: number; reviewCommentId: bigint | null; reviewBody: string | null; status: string;
        }[]>`SELECT "headSha", "reviewRequestVersion", "reviewCommentId", "reviewBody", status
             FROM pull_requests WHERE id = ${target.pullRequestId} FOR UPDATE`;
        if (!current || current.headSha !== target.headSha || current.reviewRequestVersion !== target.reviewRequestVersion
          || (target.expectedReviewBody !== undefined && current.reviewBody !== target.expectedReviewBody)) return null;
        if (target.expectedReviewBody === undefined && current.status === "completed") return null;

        const attempts = await tx.reviewAttempt.findMany({
          where: { pullRequestId: target.pullRequestId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5,
          select: { id: true, headSha: true, createdAt: true },
        });
        const history = attempts.length ? `\n\n<details>\n<summary>Review history (latest ${attempts.length})</summary>\n\n` + attempts.map(attempt => {
          const url = new URL(`/api/review-attempts/${attempt.id}`, process.env.NEXT_PUBLIC_APP_URL ?? "https://octopus-review.ai").href;
          return `- [${attempt.headSha?.slice(0, 7) ?? "Unknown head"} · ${attempt.createdAt.toISOString()}](${url})`;
        }).join("\n") + "\n\nReview records require Octopus organization access.\n\n</details>" : "";
        // Place history before the footer so consumers can still identify the head.
        const footer = /\n*Last reviewed commit: [0-9a-f]{40}\s*$/i.exec(target.body)?.[0] ?? "";
        const body = (footer ? target.body.slice(0, -footer.length) : target.body) + history + footer;
        signal.throwIfAborted();
        let id = current.reviewCommentId === null ? null : Number(current.reviewCommentId);
        if (id === null) {
          const reserved = -Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1) + 1);
          await tx.pullRequest.updateMany({ where: { id: target.pullRequestId }, data: { reviewCommentId: reserved } });
          return { reserved };
        }
        const marker = id < 0 ? `<!-- octopus-summary:${target.pullRequestId}:${-id} -->` : undefined;
        if (id < 0 && id !== reservation) {
          id = await findPullRequestSummaryComment(target.owner, target.repo, target.prNumber, marker!, token, signal);
          if (id === null) throw new Error("PR summary creation is unresolved; awaiting reconciliation");
        }
        if (id > 0) {
          try {
            await updatePullRequestComment(target.installationId, target.owner, target.repo, id, body, token, signal, marker);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "Failed to update PR comment: 404") throw error;
            const reserved = -Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1) + 1);
            await tx.pullRequest.updateMany({ where: { id: target.pullRequestId }, data: { reviewCommentId: reserved } });
            return { reserved };
          }
        } else {
          signal.throwIfAborted();
          creationAttempted = true;
          try {
            id = await createPullRequestComment(target.installationId, target.owner, target.repo, target.prNumber, body, token, signal, marker);
          } catch (error) {
            // These responses confirm rejection. Timeouts, network failures and
            // server errors may have created the comment and require reconciliation.
            creationRejected = error instanceof Error && /^Failed to create PR comment: (400|401|403|404|410|422|429)$/.test(error.message);
            throw error;
          }
        }
        await tx.pullRequest.updateMany({ where: { id: target.pullRequestId }, data: { reviewCommentId: id } });
        return id;
      }, { timeout: 20_000, maxWait: 10_000 });
      if (result === null && reservation !== undefined) {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.pullRequest.updateMany({ where: { id: target.pullRequestId, reviewCommentId: reservation }, data: { reviewCommentId: null } });
        });
      }
      if (result === null || typeof result === "number") return result;
      reservation = result.reserved;
    } catch (error) {
      if (reservation !== undefined && (!creationAttempted || creationRejected)) {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.pullRequest.updateMany({ where: { id: target.pullRequestId, reviewCommentId: reservation }, data: { reviewCommentId: null } });
        });
      }
      throw error;
    }
  }
}
