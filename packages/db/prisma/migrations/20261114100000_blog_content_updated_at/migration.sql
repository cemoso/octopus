-- When a published post's title, text or summary was last edited. Null means
-- it has not been edited since publication; readers of this column fall back
-- to "publishedAt". No backfill: "updatedAt" cannot tell a text edit from any
-- other write.
ALTER TABLE "blog_posts" ADD COLUMN "contentUpdatedAt" TIMESTAMP(3);
