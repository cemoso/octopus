ALTER TABLE "repositories" ADD COLUMN "indexRetryAfter" TIMESTAMP(3);
ALTER TABLE "repositories" ADD COLUMN "indexRetryInstallationId" INTEGER;
