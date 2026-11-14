import { CARD_SIZE, titleCard } from "@/lib/og-card";

export const alt = "Octopus in your editor";
export const size = CARD_SIZE;
export const contentType = "image/png";

export default function Image() {
  return titleCard("Octopus in your editor", "octopus-review.ai/editor");
}
