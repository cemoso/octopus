import { expect, it } from "bun:test";
import { reconcileRelatedCandidates, relatedPosts } from "@/lib/blog-related";

// Newest first, as the page passes them.
const posts = [
  { slug: "bigger-prs", title: "Bigger PRs", tags: ["code-review", "pull-requests", "pr-size"] },
  { slug: "ignored-comments", title: "Ignored comments", tags: ["code-review", "false-positives"] },
  { slug: "slow-reviews", title: "Slow reviews", tags: ["Code Review", "pull-requests"] },
  { slug: "alert-fatigue", title: "Alert fatigue", tags: ["code-review", "false-positives", "alert-fatigue"] },
  { slug: "doubled-prs", title: "Doubled PRs", tags: ["code-review", "pull-requests", "pr-size"] },
  { slug: "release-notes", title: "Release notes", tags: ["code-review"] },
  { slug: "sticker-story", title: "Sticker story", tags: ["branding"] },
];
const slugs = (slug: string, limit?: number) => relatedPosts(slug, posts, limit).map((post) => post.slug);

it("puts the posts that share a post's rarest tags first", () => {
  // "pr-size" is rarer than "pull-requests", so the post sharing both leads.
  expect(slugs("bigger-prs", 2)).toEqual(["doubled-prs", "slow-reviews"]);
  expect(slugs("ignored-comments", 1)).toEqual(["alert-fatigue"]);
});

it("counts a tag that nearly every post carries for little", () => {
  // "code-review" is on six of the seven posts: posts sharing only that come after every closer match.
  expect(slugs("bigger-prs", 10)).toEqual(["doubled-prs", "slow-reviews", "ignored-comments", "alert-fatigue", "release-notes"]);
});

it("treats differently written tags as the same tag", () => {
  expect(slugs("slow-reviews", 2)).toEqual(["bigger-prs", "doubled-prs"]);
});

it("keeps to the limit, never lists the post itself, and breaks ties by the given order", () => {
  expect(slugs("doubled-prs", 1)).toEqual(["bigger-prs"]);
  expect(slugs("bigger-prs", 10)).not.toContain("bigger-prs");
  // Equal scores: the earlier (newer) post comes first.
  expect(slugs("release-notes", 2)).toEqual(["bigger-prs", "ignored-comments"]);
});

it("keeps input order when equal scores have different tag orders", () => {
  const candidates = [
    { slug: "current", title: "Current", tags: ["a", "b", "c"] },
    { slug: "newer", title: "Newer", tags: ["a", "b", "c"] },
    { slug: "older", title: "Older", tags: ["c", "b", "a"] },
    { slug: "other-1", title: "Other 1", tags: ["b", "c"] },
    { slug: "other-2", title: "Other 2", tags: ["b", "c"] },
  ];
  expect(relatedPosts("current", candidates, 2).map((post) => post.slug)).toEqual(["newer", "older"]);
});

it("returns nothing for a post with no tag in common, or an unknown post", () => {
  expect(slugs("sticker-story")).toEqual([]);
  expect(slugs("no-such-post")).toEqual([]);
});

it("scores only currently eligible posts, including newly published posts", () => {
  const cached = [posts[0], posts[1], posts[6]];
  const newlyPublished = posts[4];
  const candidates = reconcileRelatedCandidates(
    [{ slug: newlyPublished.slug }, { slug: posts[0].slug }, { slug: posts[6].slug }],
    cached,
    [newlyPublished],
  );
  expect(relatedPosts(newlyPublished.slug, candidates).map((post) => post.slug)).toEqual([posts[0].slug]);
  expect(relatedPosts(posts[0].slug, candidates).map((post) => post.slug)).toEqual([newlyPublished.slug]);
});
