import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import type { IndexStats } from "@/lib/indexer";
import { GitHubTreeRestrictedError } from "@/lib/repository-tree-error";

const TREE_RESTRICTION_RETRY_DELAY_MS = 6 * 60 * 60_000;

export const treeRestrictionEligible = (now: Date, installationId: number | null): Prisma.RepositoryWhereInput => installationId === null ? {} : ({
  OR: [{ provider: { not: "github" } }, { indexRetryAfter: null }, { indexRetryAfter: { lte: now } },
    { indexRetryInstallationId: null }, { indexRetryInstallationId: { not: installationId } }],
});

/** A replacement attempt or cancellation owns the row now. */
export class SupersededIndexError extends Error {
  constructor() { super("Indexing attempt is no longer current"); }
}

export function isIndexingCancelled(signal?: AbortSignal): boolean {
  return !!signal?.aborted && signal.reason?.name !== "TimeoutError";
}

/** Persist a complete snapshot and its milestones in one guarded transaction. */
export async function runRepositoryIndex(
  repositoryId: string,
  indexAttemptId: string,
  work: () => Promise<IndexStats>,
  signal?: AbortSignal,
  options?: { installationId?: number },
): Promise<IndexStats> {
  const where = { id: repositoryId, indexStatus: "indexing", indexAttemptId };
  let binding: Prisma.RepositoryWhereInput | undefined;
  try {
    const attempt = await prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId }, select: { indexStatus: true, indexAttemptId: true, provider: true,
        organizationId: true, installationId: true, organization: { select: { githubInstallationId: true } } },
    });
    if (attempt.indexStatus !== "indexing" || attempt.indexAttemptId !== indexAttemptId) {
      throw new SupersededIndexError();
    }
    binding = options?.installationId && attempt.provider === "github" &&
      (attempt.installationId ?? attempt.organization.githubInstallationId) === options.installationId
      ? { provider: "github", organizationId: attempt.organizationId, installationId: attempt.installationId,
        organization: { githubInstallationId: attempt.organization.githubInstallationId } }
      : undefined;
    signal?.throwIfAborted();
    const stats = await work();
    signal?.throwIfAborted();
    if (stats.totalChunks !== stats.totalVectors || stats.totalChunks < 0 ||
        (stats.totalChunks > 0 && stats.indexedFiles <= 0)) {
      throw new Error("Indexing incomplete: invalid completion statistics");
    }
    await prisma.$transaction(async tx => {
      signal?.throwIfAborted();
      const saved = await tx.repository.updateMany({ where, data: {
        indexStatus: "indexed",
        activeIndexGeneration: indexAttemptId,
        totalFiles: stats.totalFiles, indexedFiles: stats.indexedFiles,
        totalChunks: stats.totalChunks, totalVectors: stats.totalVectors,
        contributorCount: stats.contributorCount,
        contributors: JSON.parse(JSON.stringify(stats.contributors)),
        indexDurationMs: stats.durationMs,
        ...(stats.resolvedDefaultBranch ? { defaultBranch: stats.resolvedDefaultBranch } : {}),
      } });
      if (saved.count !== 1) throw new SupersededIndexError();
      if (binding) await tx.repository.updateMany({
        where: { id: repositoryId, indexStatus: "indexed", indexAttemptId, ...binding },
        data: { indexRetryAfter: null, indexRetryInstallationId: null },
      });
      signal?.throwIfAborted();
      // Empty snapshots are valid for reviewing a first PR, but deliver no
      // indexed content. Leave existing dates unchanged.
      if (stats.indexedFiles > 0 && stats.totalChunks > 0 && stats.totalVectors === stats.totalChunks) {
        await recordRepositoryIndexCompletion(tx, repositoryId);
      }
    });
    return stats;
  } catch (error) {
    // Never let an expired worker overwrite its replacement's state.
    const released = await prisma.$transaction(async tx => {
      const result = await tx.repository.updateMany({ where, data: {
        indexStatus: isIndexingCancelled(signal) ? "pending" : "failed",
      } });
      if (result.count && binding && options?.installationId && !signal?.aborted) {
        const installationId = options.installationId;
        const restriction = error instanceof GitHubTreeRestrictedError;
        await tx.repository.updateMany({
          where: { id: repositoryId, indexStatus: "failed", indexAttemptId, ...binding },
          data: restriction
            ? { indexRetryAfter: new Date(Date.now() + TREE_RESTRICTION_RETRY_DELAY_MS), indexRetryInstallationId: installationId }
            : { indexRetryAfter: null, indexRetryInstallationId: null },
        });
      }
      return result;
    });
    if (!released.count) throw new SupersededIndexError();
    signal?.throwIfAborted();
    throw error;
  }
}

/** Only call inside the transaction that commits a verified full snapshot. */
export async function recordRepositoryIndexCompletion(
  tx: Prisma.TransactionClient,
  repositoryId: string,
  completedAt: Date = new Date(),
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "repositories"
    SET "firstIndexedAt" = CASE
          WHEN "firstIndexedAt" IS NOT NULL
            THEN LEAST("firstIndexedAt", ${completedAt}::timestamp)
          WHEN "indexedAt" IS NULL THEN ${completedAt}::timestamp
          ELSE NULL
        END,
        "indexedAt" = ${completedAt}::timestamp,
        "updatedAt" = ${completedAt}::timestamp
    WHERE "id" = ${repositoryId}
  `;
}
