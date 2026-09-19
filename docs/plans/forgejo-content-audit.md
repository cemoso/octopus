# Forgejo launch content audit

Date: 19 September 2026. Baseline: `origin/master` at `8c73c57`.

This audit covers current website copy, onboarding emails, help content and machine-readable product descriptions. The changes describe the Forgejo integration in this branch. They do not establish a deployed release or an authenticated end-to-end review against a real Forgejo installation.

## Supported connection described in the copy

Connect an HTTPS Forgejo instance with a personal access token. A dedicated bot account is recommended, with `read:user`, `write:repository` and `write:issue` scopes. Octopus encrypts the personal access token and syncs repositories where the account has admin access. An administrator adds a signed pull-request webhook to each Forgejo repository using the URL and secret shown in Octopus. Reviews produce comments and commit statuses; users can request another review in Octopus. Enable issue comment webhook events for `/octopus` or `@octopus` requests on pull requests.

Octopus Cloud connects to public HTTPS instances. Private LAN/VPN Forgejo instances require self-hosted Octopus within the network, using the official self-host image (`NEXT_PUBLIC_OCTOPUS_SELF_HOSTED=true` baked in at build time) or the alternative `OCTOPUS_SELF_HOSTED=true` runtime server flag for custom/prebuilt images. Either mode is sufficient; the public build flag is not a runtime enable switch. Set `FORGEJO_ALLOWED_PRIVATE_ORIGINS` to comma-separated exact HTTPS origins. Web and review workers need matching allowlists, DNS and routes. An internal CA uses a mounted trusted PEM file through `NODE_EXTRA_CA_CERTS`; TLS verification stays enabled. Loopback, link-local and metadata destinations remain blocked. Forgejo hosts the repositories, while Octopus and configured AI services process code for indexing and reviews. Hosting Forgejo yourself does not make Octopus Cloud processing local. Native CLI agent onboarding remains explicitly GitHub-only.

## Essential launch content updated

Paths and line references below point to this branch; later code edits may move lines.

| Surface | Source | Change |
| --- | --- | --- |
| Homepage | `apps/web/app/(landing)/page.tsx:36`, `:67`, `:80`, `:249`, `:270` | Provider list, product JSON-LD, visible Forgejo setup link and cloud features. Qualified local-processing claims. |
| SEO and social previews | `apps/web/app/layout.tsx:34`, `:43`, `:59`, `:73` | Description, Forgejo keyword, Open Graph and Twitter copy. |
| Shared structured data | `apps/web/lib/structured-data.ts:34`, `:92` | Organization and product/pricing descriptions. |
| Sign-in product panel | `apps/web/app/(auth)/login/login-content.tsx:69` | Forgejo in review-provider list, setup-aware onboarding copy and a data-retention link. Sign-in methods are unchanged. |
| Adjacent connection dialogs | `apps/web/components/dashboard/providers-banner.tsx`; `apps/web/app/(app)/settings/integrations/gitlab-integration-card.tsx`; `bitbucket-integration-card.tsx` in the same directory | Removed four inaccurate "we never store your code" promises; dialogs now state that Octopus accesses repository content for indexing and posts review comments. |
| Setup instructions | `apps/web/app/(landing)/docs/integrations/page.tsx:157` | `/docs/integrations#forgejo`: token scopes, admin access, manual signed webhooks, public/private connection choices and processing location. |
| Quickstart | `apps/web/app/(landing)/docs/getting-started/page.tsx:26`, `:91`, `:110`, `:133` | Fourth provider card and accurate setup method. Generic cloud entry no longer sends every user to GitHub App installation. |
| FAQ | `apps/web/app/(landing)/docs/faq/page.tsx:17`, `:40`, `:59`, `:62` | Provider coverage and a direct answer about self-hosted Forgejo versus where code is processed. |
| Self-hosting and private-network setup | `apps/web/app/(landing)/docs/self-hosting/page.tsx:161`, `:268`, `:278`, `:341`; `env-generator.tsx:43` in the same directory | Forgejo instructions, exact-origin allowlist, worker/network/DNS requirements and trusted internal CA setup; GitHub credentials apply only to GitHub. |
| Environment examples | `.env.example:71`; `apps/web/app/(landing)/docs/self-hosting/env-generator.tsx:53` | Optional private Forgejo origin allowlist and CA file settings, with the build-time image mode or alternative runtime server flag. |
| Mobile docs header | `apps/web/app/(landing)/docs/layout.tsx:29` | Browser QA found the existing header CTA extending to 453px at a 390px viewport. Reduced mobile spacing and hid the redundant brand word on small screens; the logo keeps its accessible name. Desktop layout is unchanged. |
| Help search | `apps/web/app/(landing)/docs/docs-search.tsx:60` | Forgejo, token and self-hosted keywords; refreshed integration description. |
| Other help references | `apps/web/app/(landing)/docs/about/page.tsx:88`, `:130`; `docs/glossary/page.tsx:87`; `docs/github-action/page.tsx:528` under the same landing directory | Current provider descriptions and related-links copy. GitHub Action itself remains GitHub-specific. |
| Comparison pages | `apps/web/app/(landing)/vs-coderabbit/page.tsx:44`; `vs-greptile/page.tsx:36` in the same directory | Added Octopus Forgejo FAQ. No unverified competitor support claims. |
| Privacy data flow | `apps/web/app/(landing)/docs/privacy/page.tsx:56`, `:61`, `:117` | Forgejo repository access and processing location. |
| Security overview | `apps/web/app/(landing)/docs/security-overview/page.tsx:31`, `:52`, `:80`, `:107` | Signed Forgejo webhooks, encrypted personal access tokens, a separate webhook secret per integration and code-host access. Webhook secrets are stored in a plain database column; no encryption claim is made for them. |
| Instance operator distinction | `apps/web/app/(landing)/docs/sub-processors/page.tsx:173` | Forgejo is software; the chosen instance operator and AI services determine the parties handling data. |
| Security program scope | `apps/web/app/(landing)/bug-bounty/page.tsx:98` | Includes Forgejo integration flows. |
| Repository introduction | `README.md:7`, `:39`, `:42`, `:58` | Provider list and Forgejo setup/data-flow note. Existing GitHub setup prompt remains scoped. |
| Public assistant knowledge | `apps/web/lib/docs-content.ts:30`, `:93`, `:264`, `:314`, `:375`; `apps/web/app/api/ask-octopus/route.ts:60` | Mirrored setup information and explicit Forgejo boundaries. |
| LLM discovery | `apps/web/public/llms.txt:3`, `:20`, `:28`; `apps/web/app/llms-full.txt/route.ts:12` | Forgejo discovery and setup link. GitHub reply-follow-up claim is explicitly scoped. |
| Welcome email | `apps/web/lib/email-template-seeds.ts:33` | Includes all four providers and a Forgejo guide, with token/webhook steps and processing disclosure. |
| Getting-started and reminder emails | `apps/web/lib/email-template-seeds.ts:241`, `:264` | Same provider coverage and Forgejo setup link. Removed inaccurate one-minute/setup-complete claims. |
| Existing email templates | `packages/db/prisma/migrations/20260919153000_forgejo_email_templates/migration.sql:1` | Updates only exact old default bodies on system templates. Custom bodies, sender, subject, enabled state and delivery preferences stay intact. No email is sent. |

## Deployment steps that source changes do not complete

1. Deploy the integration and content together after validation. Public copy must not precede functioning connection and review routes.
2. Apply both Forgejo migrations. Updating `email-template-seeds.ts` alone does not update existing records: `seedEmailTemplates` skips existing slugs, and `renderEmailTemplate` reads the database (`apps/web/lib/email-template-seeds.ts:342`; `apps/web/lib/email-renderer.ts:21`). The guarded migration updates untouched defaults; customized templates need a separate editorial review.
3. Refresh the public assistant's indexed documentation after deployment using the existing authorized `POST /api/admin/seed-docs` process. That endpoint replaces the docs collection (`apps/web/app/api/admin/seed-docs/route.ts:27`). Source updates and `/llms-full.txt` do not by themselves refresh existing Qdrant docs chunks.
4. Verify the live homepage, sign-in panel, `/docs/integrations#forgejo`, help search and rendered email preview. Do not send test emails to users as part of validation.
5. Verify private-network connectivity from both web and review workers, including an allowed-origin rejection check and an internal-CA connection where applicable. No shared infrastructure configuration is part of this source change.
6. Connect an authorized Forgejo test repository and verify a signed event through an actual completed review, inline/summary comments and final commit status. Local fixtures and browser previews do not establish this live result.

## Follow-up content and claims

- **GitHub organization profile:** a read-only GitHub API check on 19 September found `octopusreview/.github`, `profile/README.md:9`, still saying findings appear in GitHub, GitLab and Bitbucket (blob `2c701e1f14b57c3b0f26f9266e4a67d056f3d8b9`). Add Forgejo and the integration-guide link in that separate repository after launch. Preserve the GitHub-only agent setup instructions. No external profile was edited.
- **External campaigns and social bios:** no current campaign or social-account inventory was available in this repository audit. Check active ads, pinned social posts, launch directories and sales templates for exhaustive three-provider lists after the integration is live. No campaigns or posts were changed.
- **Historical blog posts, changelog and screenshots:** preserve dated statements and real GitHub example screenshots. Publish a Forgejo launch note or capture a real Forgejo review after live verification instead of rewriting history. Blog bodies are database-backed, so a source scan is not a complete live editorial inventory (`apps/web/app/(landing)/blog/[slug]/page.tsx`).
- **Competitor comparisons:** current Octopus Forgejo FAQs are updated. Add comparison-table Forgejo rows only after independently checking each competitor's current support.
- **Privacy/storage assertions corrected on touched surfaces:** homepage cloud copy, login, the FAQ and privacy storage section now describe stored review/indexing data and link to the retention documentation. Removed absolute source-storage and model-training claims from these touched passages and the mirrored assistant corpus. A full privacy-policy, retention and vendor-terms verification remains outside this integration change.
- **GitHub-specific product paths:** native agent setup, GitHub Action, GitHub issue creation and dependency analysis retain their existing scope. Do not add Forgejo to their claims without corresponding implementation and validation.

## Content validation evidence

- Full suite: `bun test --timeout 15000` passed with 1,836 passing tests, 43 skipped and zero failures. An infrastructure fixture exceeded the default five-second timeout on the first run; the full run with a 15-second timeout passed.
- Lint, typecheck and production build passed on the final source, including the runtime self-host flag correction. The focused Forgejo harness also passed after that correction.
- The actual Forgejo schema SQL was applied transactionally to a disposable PostgreSQL database; deleting the fixture organization cascaded to its Forgejo integration as expected.
- Dashboard and settings browser checks passed at 1280px and 390px without horizontal overflow. Keyboard order followed host → token → Connect. A failed connection preserved the entered form values.
- Scoped ESLint passed for the edited website, docs, metadata, assistant and email-template files.
- `forgejo-email-migration.test.ts` passed against a fresh local PostgreSQL database: 1 test, 53 assertions. It executes the real migration twice, verifies all three new bodies match their seeds, and preserves custom bodies, non-system templates, disabled delivery, sender and subject. The test uses a temporary table and accepts only a test database URL. The disposable cluster was stopped and removed afterward.
- To repeat that database check: `FORGEJO_EMAIL_TEST_DATABASE_URL=postgres://.../forgejo_email_test bun test apps/web/lib/__tests__/forgejo-email-migration.test.ts`. The test skips when the variable is absent.
- Updated welcome email was rendered through the existing `renderEmailPreview` function with the database mocked, without sending. Local artifact: `/tmp/octopus-forgejo-welcome.html`.
- Chrome preview checked at 1200px desktop and 390px narrow viewport. Both had zero horizontal overflow; the logo loaded and Forgejo guide, dashboard and preference links resolved to their intended destinations. Screenshots: `/tmp/octopus-forgejo-welcome.png` and `/tmp/octopus-forgejo-welcome-mobile.png`. This is browser HTML validation, not inbox-client deliverability testing.
- Real local Next.js pages were checked against the disposable database at `http://localhost:3117`: homepage, `/docs/integrations#forgejo` and `/docs/self-hosting#forgejo` at 1440px and 390px. The homepage link and private-setup link navigated to the right anchors. Allowed-origin, self-host flag, worker/DNS and trusted-CA instructions rendered. A pre-existing mobile header overflow was fixed; all three pages then fit both widths. Screenshots are under `/tmp/octopus-forgejo-ui-evidence/` (`homepage.png`, `homepage-mobile.png`, `docs-forgejo.png`, `docs-forgejo-mobile.png`, `docs-private-forgejo-mobile.png`). This remains local preview evidence, not production or authenticated Forgejo execution.
- Full integration checks and real Forgejo end-to-end evidence are tracked by the implementation task; this content audit makes no production deployment claim.
- A real authenticated Forgejo pull request and an actual private VPN deployment remain unverified. Fixture tests and local UI checks do not establish those outcomes.

## Automatic review events

Forgejo emits `pull_request` / `edited` with `changes.title.from` when a PR title
changes ([upstream notifier](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/services/webhook/notifier.go)).
Draft status comes from configurable title prefixes
([upstream draft detection](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/models/issues/pull.go)),
so Octopus accepts this title-change event and fetches authoritative PR metadata.
Only open, non-draft PRs are eligible. Body and other edits do not trigger reviews;
automatic events skip heads with an existing review attempt. An unreviewed ready
PR can therefore receive its first automatic review on a title change. Manual
requests use only complete `@octopus` and `/octopus` commands.

Forgejo webhook acceptance, review admission, and the pg-boss job commit in one
PostgreSQL transaction. A crash before commit leaves none of them committed;
retry admits the same request version. A crash after commit leaves the signed
payload identity durable, so replay cannot enqueue another review even after
the first completes. Forgejo acceptance records are excluded from the telemetry
retention sweep. The review worker publishes the initial comment after commit.
