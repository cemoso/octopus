import { describe, it, expect } from "bun:test";
import { proseWordCount, readingTimeMinutes, extractHeadings, changesPublishedText, postModifiedAt } from "../blog-reading";

describe("proseWordCount", () => {
  it("counts prose words", () => {
    expect(proseWordCount("one two three")).toBe(3);
  });
  it("strips inline + fenced code and image markup", () => {
    const md = "one `two` three\n```\nlots of code here\n```\n![alt](/x.png) four";
    expect(proseWordCount(md)).toBe(3); // one, three, four (code + image markup removed)
  });
  it("keeps link text but drops the url", () => {
    expect(proseWordCount("see [the docs](https://example.com/a/b) now")).toBe(4);
  });
});

describe("readingTimeMinutes", () => {
  it("is at least 1 minute", () => {
    expect(readingTimeMinutes("hello world")).toBe(1);
  });
  it("scales at ~200 wpm", () => {
    expect(readingTimeMinutes(Array(600).fill("word").join(" "))).toBe(3);
  });
  it("ignores code fences", () => {
    const md = "```\n" + Array(1000).fill("code").join(" ") + "\n```\nhello world";
    expect(readingTimeMinutes(md)).toBe(1);
  });
});

describe("extractHeadings", () => {
  it("extracts h2/h3 with slugged ids matching rehype-slug", () => {
    expect(extractHeadings("## Getting Started\ntext\n### Sub Section")).toEqual([
      { depth: 2, text: "Getting Started", id: "getting-started" },
      { depth: 3, text: "Sub Section", id: "sub-section" },
    ]);
  });
  it("ignores headings inside a code fence", () => {
    expect(extractHeadings("```\n## Not A Heading\n```\n## Real Heading")).toEqual([
      { depth: 2, text: "Real Heading", id: "real-heading" },
    ]);
  });
  it("does not leak headings from nested/mixed fences (tilde outer, backtick inner)", () => {
    const md = "~~~\n```\n## Phantom\n```\n~~~\n## Real";
    expect(extractHeadings(md).map((h) => h.text)).toEqual(["Real"]);
  });
  it("dedupes duplicate heading slugs like github-slugger", () => {
    expect(extractHeadings("## Setup\n## Setup").map((h) => h.id)).toEqual([
      "setup",
      "setup-1",
    ]);
  });
  it("does not treat h1 or h4 as TOC entries", () => {
    expect(extractHeadings("# Title\n#### Deep\n## Section").map((h) => h.text)).toEqual([
      "Section",
    ]);
  });
});

describe("changesPublishedText", () => {
  const published = { status: "published", title: "Title", content: "Body", excerpt: "Summary" };

  it("is true when the title, the text or the summary of a published post changes", () => {
    expect(changesPublishedText(published, { title: "New title" })).toBe(true);
    expect(changesPublishedText(published, { content: "New body" })).toBe(true);
    expect(changesPublishedText(published, { excerpt: "New summary" })).toBe(true);
    expect(changesPublishedText(published, { excerpt: null })).toBe(true);
  });

  it("is false when the same text is sent again, or the edit touches no text", () => {
    expect(changesPublishedText(published, { title: "Title", content: "Body", excerpt: "Summary" })).toBe(false);
    // Tags, audio, cover image and category arrive as other fields; none of them is text.
    expect(changesPublishedText(published, {})).toBe(false);
  });

  it("is false for a draft: its date starts when it is published", () => {
    expect(changesPublishedText({ ...published, status: "draft" }, { content: "New body" })).toBe(false);
  });
});

describe("postModifiedAt", () => {
  const published = new Date("2026-03-25T10:00:00Z");
  const edited = new Date("2026-05-02T09:30:00Z");

  it("is the last text edit when there was one, otherwise the publication date", () => {
    expect(postModifiedAt({ contentUpdatedAt: edited, publishedAt: published })).toEqual(edited);
    expect(postModifiedAt({ contentUpdatedAt: null, publishedAt: published })).toEqual(published);
    expect(postModifiedAt({ contentUpdatedAt: null, publishedAt: null })).toBeNull();
  });
});
