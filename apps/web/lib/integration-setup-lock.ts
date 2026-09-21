import "server-only";
import { prisma } from "@octopus/db";

/** Serialize hook list/create across web callbacks, manual retries and discovery workers. */
export async function withWebhookSetupLock<T>(key: string, setup: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`webhook-setup:${key}`}, 0)) AS acquired`;
    if (!lock?.acquired) throw new Error("Webhook setup is already running. Retry shortly.");
    return setup();
  }, { timeout: 60_000 });
}
