import { expect, it } from "bun:test";
import { titleCard, titleFontSize } from "@/lib/og-card";

it("renders a PNG of the size social networks expect", async () => {
  const response = await titleCard("Claude Fable 5.2 is now available in Octopus", "octopus-review.ai/blog");
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  const png = Buffer.from(await response.arrayBuffer());
  // PNG signature, then the IHDR chunk's width and height.
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({ width: 1200, height: 630 });
  expect(png.length).toBeGreaterThan(5000);
}, 30000);

it("renders a card for a title far longer than the card can show", async () => {
  const response = await titleCard("A very long title ".repeat(30), "octopus-review.ai/blog");
  const png = Buffer.from(await response.arrayBuffer());
  expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({ width: 1200, height: 630 });
}, 30000);

it("sets longer titles in smaller type", () => {
  const sizes = [20, 55, 90, 120].map((length) => titleFontSize("x".repeat(length)));
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  expect(new Set(sizes).size).toBe(4);
});
