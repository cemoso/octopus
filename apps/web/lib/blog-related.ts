export type RelatedCandidate = { slug: string; title: string; tags: string[] };

/** "Code Review" and "code-review" are the same tag. */
const tagKey = (tag: string) => tag.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * The posts most related to `slug`: the ones that share its rarest tags. A tag
 * that most posts carry says little, so each shared tag counts for
 * log(all posts / posts with that tag). Ties keep the order of `posts`, so pass
 * them newest first.
 */
export function relatedPosts(slug: string, posts: RelatedCandidate[], limit = 3): RelatedCandidate[] {
  const current = posts.find((post) => post.slug === slug);
  if (!current) return [];
  const postsWithTag = new Map<string, number>();
  for (const post of posts) {
    for (const tag of new Set(post.tags.map(tagKey))) postsWithTag.set(tag, (postsWithTag.get(tag) ?? 0) + 1);
  }
  const mine = new Set(current.tags.map(tagKey));
  return posts
    .filter((post) => post.slug !== slug)
    .map((post) => ({
      post,
      score: [...new Set(post.tags.map(tagKey))]
        .filter((tag) => mine.has(tag))
        .reduce((sum, tag) => sum + Math.log(posts.length / postsWithTag.get(tag)!), 0),
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.post);
}
