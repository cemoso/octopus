import { CARD_SIZE, titleCard } from "@/lib/og-card";

export const alt = "Octopus vs Greptile";
export const size = CARD_SIZE;
export const contentType = "image/png";

export default function Image() {
  return titleCard("Octopus vs Greptile", "octopus-review.ai/vs-greptile");
}
