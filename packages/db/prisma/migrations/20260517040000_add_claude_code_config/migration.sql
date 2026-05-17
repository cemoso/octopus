-- AlterTable: per-org auth mode + optional API key for the Claude Code
-- provider. claudeCodeAuthMode is "subscription" | "api-key"; when null,
-- the provider returns an unconfigured error.
ALTER TABLE "public"."organizations" ADD COLUMN "claudeCodeAuthMode" TEXT;
ALTER TABLE "public"."organizations" ADD COLUMN "claudeCodeApiKey" TEXT;
