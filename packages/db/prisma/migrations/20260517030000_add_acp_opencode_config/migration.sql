-- AlterTable: per-org config for the ACPX and OpenCode gateway providers.
ALTER TABLE "public"."organizations" ADD COLUMN "acpBaseUrl" TEXT;
ALTER TABLE "public"."organizations" ADD COLUMN "acpApiKey" TEXT;
ALTER TABLE "public"."organizations" ADD COLUMN "opencodeBaseUrl" TEXT;
ALTER TABLE "public"."organizations" ADD COLUMN "opencodeApiKey" TEXT;
