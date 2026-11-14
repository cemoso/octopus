import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const CARD_SIZE = { width: 1200, height: 630 };

const MAX_TITLE = 120;

/** Long titles are set smaller so they stay inside the card. */
export function titleFontSize(title: string): number {
  if (title.length <= 40) return 80;
  if (title.length <= 70) return 66;
  if (title.length <= 100) return 54;
  return 46;
}

/**
 * A 1200x630 social preview card: the page's title on the site's dark
 * background with the logo, and a short line saying where the link leads.
 */
export async function titleCard(title: string, label: string): Promise<ImageResponse> {
  const logo = await readFile(join(process.cwd(), "public/web-app-manifest-192x192.png"));
  const shown = title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#0C0A09",
          color: "#FAFAF9",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 38 }}>
          <img src={`data:image/png;base64,${logo.toString("base64")}`} width={96} height={96} alt="" />
          Octopus
        </div>
        <div style={{ display: "flex", fontSize: titleFontSize(shown), lineHeight: 1.15, letterSpacing: -1.5 }}>
          {shown}
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "#15BA81" }}>{label}</div>
      </div>
    ),
    // A day, not the default year: a post's title can be edited.
    { ...CARD_SIZE, headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
