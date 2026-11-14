import { prisma } from "@octopus/db";
import { titleCard } from "@/lib/og-card";

// Social preview card for a post that has no cover image: /blog/<slug>/card
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await prisma.blogPost.findFirst({
    where: { slug, status: "published", deletedAt: null },
    select: { title: true },
  });
  if (!post) return new Response("Not found", { status: 404 });
  return titleCard(post.title, "octopus-review.ai/blog");
}
