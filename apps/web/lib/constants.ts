export const DISCORD_INVITE_URL = "https://discord.gg/qyuWTXghbS";
export const MAX_OWNED_ORGS_PER_USER = 3;
// Output token budget for one review request. A model that reasons counts its
// hidden reasoning tokens against this budget, so a review that comes back cut
// off (finish_reason "length") needs a larger value than the 8192 default.
// Server-runtime configurable via OCTOPUS_REVIEW_MAX_TOKENS.
export const REVIEW_MAX_TOKENS = Math.max(1, Math.floor(Number(process.env.OCTOPUS_REVIEW_MAX_TOKENS) || 8192));
// Welcome credits granted once, on a user's first organization (USD).
export const WELCOME_FREE_CREDITS = 150;
