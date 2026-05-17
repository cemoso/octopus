-- AlterTable: SystemConfig gains a cached snapshot of the latest GitHub
-- Release. Refreshed daily by the pg-boss "refresh-release-cache" worker
-- so the self-hosted update page reads a sub-millisecond local lookup
-- instead of the rate-limited GitHub API on every render.
ALTER TABLE "public"."system_config" ADD COLUMN "latestRelease" JSONB;
