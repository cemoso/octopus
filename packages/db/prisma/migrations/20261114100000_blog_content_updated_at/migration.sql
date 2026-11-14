-- When a published post's title, text or summary was last edited. Null means
-- no such edit has been recorded; readers fall back to "publishedAt". No
-- backfill: "updatedAt" cannot distinguish a text edit from another write.
ALTER TABLE "blog_posts" ADD COLUMN "contentUpdatedAt" TIMESTAMP(3);
