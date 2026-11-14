import { CARD_SIZE, titleCard } from "@/lib/og-card";

export const alt = "Octopus vs CodeRabbit";
export const size = CARD_SIZE;
export const contentType = "image/png";

export default function Image() {
  return titleCard("Octopus vs CodeRabbit", "octopus-review.ai/vs-coderabbit");
}
