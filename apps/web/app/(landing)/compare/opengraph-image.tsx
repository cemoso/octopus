import { CARD_SIZE, titleCard } from "@/lib/og-card";

export const alt = "Compare Octopus with other AI code review tools";
export const size = CARD_SIZE;
export const contentType = "image/png";

export default function Image() {
  return titleCard("Compare Octopus with other AI code review tools", "octopus-review.ai/compare");
}
