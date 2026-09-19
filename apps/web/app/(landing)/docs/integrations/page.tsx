import {
  IconBrandGithub,
  IconBrandBitbucket,
  IconBrandGitlab,
  IconBrandSlack,
  IconPlugConnected,
  IconWebhook,
  IconMessage,
  IconGitPullRequest,
  IconCode,
  IconChecklist,
  IconBug,
  IconServer,
} from "@tabler/icons-react";
import { docsPageJsonLd, jsonLd } from "@/lib/structured-data";

export const metadata = {
  title: "Integrations — Octopus Docs",
  description:
    "Connect Octopus to GitHub, GitLab (including self-hosted), Bitbucket, Forgejo, Linear, Jira, and Slack. Automate AI code review across your team's pull request workflow in a few minutes.",
  alternates: {
    canonical: "https://octopus-review.ai/docs/integrations",
  },
};

export default function IntegrationsPage() {
  return (
    <article className="max-w-3xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            docsPageJsonLd({
              title: metadata.title,
              description: metadata.description,
              path: "/docs/integrations",
              crumb: "Integrations",
            }),
          ),
        }}
      />
      <div className="mb-8">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#555]">
          <IconPlugConnected className="size-4" />
          Integrations
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Integrations
        </h1>
        <p className="mt-3 text-lg text-[#888]">
          Connect Octopus with your existing tools for automated code reviews
          and seamless team workflows.
        </p>
      </div>

      {/* GitHub */}
      <IntegrationSection
        icon={<IconBrandGithub className="size-5" />}
        name="GitHub"
        description="Install the Octopus GitHub App to enable automatic PR reviews, check runs, and inline code comments."
        setup={[
          "Install the Octopus GitHub App from the settings page",
          "Select which repositories to monitor",
          "PRs are reviewed automatically on open and update",
        ]}
      >
        <FeatureGrid>
          <Feature
            icon={<IconGitPullRequest className="size-4" />}
            title="Automatic PR Reviews"
            description="Every new or updated pull request gets an AI-powered review with severity levels and inline comments."
          />
          <Feature
            icon={<IconChecklist className="size-4" />}
            title="Check Runs"
            description="Review results appear as GitHub check runs. Critical findings block merge with REQUEST_CHANGES."
          />
          <Feature
            icon={<IconCode className="size-4" />}
            title="Inline Comments"
            description="Findings are posted as line-by-line review comments directly on the diff."
          />
          <Feature
            icon={<IconBug className="size-4" />}
            title="Issue Creation"
            description="Create GitHub issues directly from review findings for tracking and follow-up."
          />
        </FeatureGrid>
      </IntegrationSection>

      {/* GitLab */}
      <IntegrationSection
        icon={<IconBrandGitlab className="size-5" />}
        name="GitLab"
        description="Connect your GitLab account for automatic merge request reviews. Works with both gitlab.com and self-hosted GitLab instances."
        setup={[
          "Connect GitLab from the settings page via OAuth",
          "For self-hosted GitLab, register your own OAuth application and enter the instance URL and credentials",
          "Select projects to monitor — project webhooks are created automatically",
          "MRs are reviewed automatically on open and update",
        ]}
      >
        <FeatureGrid>
          <Feature
            icon={<IconGitPullRequest className="size-4" />}
            title="MR Reviews"
            description="Automatic reviews on merge request creation and updates, with severity-rated findings."
          />
          <Feature
            icon={<IconCode className="size-4" />}
            title="Inline Comments"
            description="Findings posted as line-by-line discussion notes directly on the MR diff."
          />
          <Feature
            icon={<IconServer className="size-4" />}
            title="Self-Hosted Support"
            description="Bring your own GitLab instance. Per-org OAuth credentials override gitlab.com defaults."
          />
          <Feature
            icon={<IconWebhook className="size-4" />}
            title="Project Webhooks"
            description="One webhook per project is registered at sync time — no Premium tier required."
          />
        </FeatureGrid>
      </IntegrationSection>

      {/* Bitbucket */}
      <IntegrationSection
        icon={<IconBrandBitbucket className="size-5" />}
        name="Bitbucket"
        description="Connect your Bitbucket workspace for automated PR reviews with OAuth-based authentication."
        setup={[
          "Connect Bitbucket from the settings page via OAuth",
          "Webhooks are created automatically for selected repositories",
          "Reviews are posted as PR comments with inline code feedback",
        ]}
      >
        <FeatureGrid>
          <Feature
            icon={<IconGitPullRequest className="size-4" />}
            title="PR Reviews"
            description="Automatic reviews on pull request creation and updates."
          />
          <Feature
            icon={<IconCode className="size-4" />}
            title="Inline Comments"
            description="Findings posted as inline comments on specific lines in the diff."
          />
          <Feature
            icon={<IconWebhook className="size-4" />}
            title="Webhooks"
            description="Automatic webhook management for real-time PR event processing."
          />
        </FeatureGrid>
      </IntegrationSection>

      <IntegrationSection
        icon={<IconServer className="size-5" />}
        name="Forgejo"
        description="Choose a connection based on where Octopus runs and whether your Forgejo instance is reachable from the internet. All three options review pull requests and post comments and commit statuses."
      >
        <nav aria-label="Forgejo connection options" className="mb-6 grid gap-3">
          {[
            ["forgejo-cloud-public", "1. Octopus Cloud + public HTTPS", "Connect directly to an internet-reachable Forgejo instance."],
            ["forgejo-cloud-private", "2. Octopus Cloud + private LAN/VPN", "Run the local connector. Your Forgejo instance stays private."],
            ["forgejo-self-hosted", "3. Self-hosted Octopus + private LAN/VPN", "Connect directly from your own Octopus deployment."],
          ].map(([id, title, description]) => (
            <a key={id} href={`#${id}`} className="rounded-lg border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-cyan-400/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400">
              <span className="text-sm font-medium text-white">{title}</span>
              <span className="mt-1 block text-sm text-[#888]">{description}</span>
            </a>
          ))}
        </nav>
        <h3 className="mb-2 text-base font-semibold text-white">Before you connect</h3>
        <P>
          Create a dedicated Forgejo account with admin access only to the
          repositories you want reviewed. It does not need instance administrator
          access. In that account&apos;s Settings → Applications, generate a token
          with <code>read:user</code>, <code>write:repository</code> and{" "}
          <code>write:issue</code>. For private repositories, choose the token&apos;s{" "}
          <strong className="text-[#ccc]">All (public, private, and limited)</strong>{" "}repository
          access option. Restrict access through the dedicated account&apos;s
          repository permissions: Forgejo&apos;s <strong className="text-[#ccc]">Specific repositories</strong> tokens
          cannot include <code>read:user</code>, which Octopus uses to identify the
          connected account. See{" "}
          <a href="https://forgejo.org/docs/latest/user/authentication/token-scope/" className="text-cyan-400 underline">Forgejo&apos;s token scope guide</a>.
        </P>
        <P>One Forgejo instance can be connected per Octopus organization. Only repositories the connected account administers are synced.</P>

        <section id="forgejo-cloud-public" className="my-6 scroll-mt-24">
          <h3 className="mb-2 text-base font-semibold text-white">1. Octopus Cloud + public HTTPS</h3>
          <P>Use this when Octopus Cloud can reach your Forgejo instance over public HTTPS. Forgejo also needs outbound HTTPS access to Octopus Cloud for webhooks.</P>
          <ol className="mb-3 list-outside list-decimal space-y-2 pl-5 text-sm text-[#888]">
            <li>Open Octopus Cloud → Settings → Integrations → Forgejo and choose <strong className="text-[#ccc]">Public HTTPS instance</strong>.</li>
            <li>Enter the public HTTPS instance URL and the Forgejo personal access token. Connect and sync repositories. Octopus stores this token encrypted.</li>
            <li>Add the <a href="#forgejo-webhooks" className="text-cyan-400 underline">signed repository webhooks</a> below and enable automatic reviews.</li>
          </ol>
        </section>

        <section id="forgejo-cloud-private" className="my-6 scroll-mt-24">
          <h3 className="mb-2 text-base font-semibold text-white">2. Octopus Cloud + private LAN/VPN</h3>
          <P>
            Run the connector on a machine that can resolve and reach your private
            HTTPS Forgejo instance. The connector and Forgejo both need outbound
            HTTPS access to <code>octopus-review.ai</code> on port 443: the connector
            handles API requests, while Forgejo sends signed webhooks directly to
            Cloud. You do not need a public Forgejo address, a tunnel or an inbound
            port on the connector. This setup requires internet access.
          </P>
          <ol className="mb-3 list-outside list-decimal space-y-2 pl-5 text-sm text-[#888]">
            <li>In Octopus Cloud → Settings → Integrations → Forgejo, choose <strong className="text-[#ccc]">Private network connector</strong> and enter the exact HTTPS Forgejo origin, including its port if needed.</li>
            <li>Create the connector credential and save it when shown. This credential pairs the connector with your Octopus organization. Keep the separate Forgejo personal access token on the connector machine.</li>
            <li>On that machine, create <code>connector.env</code> with the following values. Replace the example Forgejo origin and both credential placeholders.</li>
          </ol>
          <pre className="mb-3 overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-4 text-xs text-[#bbb]"><code>{`OCTOPUS_URL=https://octopus-review.ai
OCTOPUS_CONNECTOR_TOKEN=YOUR_CONNECTOR_CREDENTIAL
FORGEJO_URL=https://forgejo.internal.example
FORGEJO_TOKEN=YOUR_FORGEJO_PERSONAL_ACCESS_TOKEN`}</code></pre>
          <P>Restrict the file to your account, then start the connector. The container needs the same VPN routes and DNS as Forgejo; access from your laptop alone does not establish access from Docker.</P>
          <pre className="mb-3 overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-4 text-xs text-[#bbb]"><code>{String.raw`chmod 600 connector.env
docker run -d --name octopus-forgejo-connector \
  --restart unless-stopped --stop-timeout 120 --read-only \
  --env-file connector.env \
  ghcr.io/octopusreview/octopus-selfhost:forgejo-connector-1.2.0`}</code></pre>
          <P>
            Forgejo must use verified HTTPS. For an internal certificate authority,
            add <code>NODE_EXTRA_CA_CERTS=/certs/forgejo-ca.pem</code> to the environment
            file and mount the trusted PEM file when creating the container with
            <code> --mount type=bind,src=/absolute/path/forgejo-ca.pem,dst=/certs/forgejo-ca.pem,readonly</code>.
            For a native process, use the certificate file&apos;s local path instead.
            Keep TLS verification enabled. Use Forgejo&apos;s LAN/VPN hostname or
            address; HTTP, redirects, localhost, loopback, link-local and cloud
            metadata addresses are not supported.
          </P>
          <ol start={4} className="mb-3 list-outside list-decimal space-y-2 pl-5 text-sm text-[#888]">
            <li>Return to Octopus and refresh the connector status. When it is online, sync repositories.</li>
            <li>In each Forgejo repository, add the <a href="#forgejo-webhooks" className="text-cyan-400 underline">signed webhook</a> using the Cloud URL and secret shown in Octopus. The webhook targets Cloud directly, not the connector.</li>
            <li>Enable automatic reviews, open a non-draft test PR and follow it in Review Logs. Check that a completed review, comments and the final commit status appear on Forgejo.</li>
          </ol>
          <P>
            Keep the connector running for indexing, reviews and comment publication.
            If it goes offline, restore its network access and refresh its status.
            To rotate its credential, generate a replacement in Octopus, update
            <code> connector.env</code> and restart the connector with the new value.
            For Docker, stop and remove the existing container, then run the
            command above again. A plain <code>docker restart</code> does not reload
            an environment file. The old credential stops working. Disconnecting deactivates the
            repositories; remove their webhooks and revoke the Forgejo token too.
          </P>
          <P>
            If a write may have reached Forgejo but its result was lost, Octopus
            pauses the connector. Check the affected PR for comments or statuses
            before choosing <strong className="text-[#ccc]">Resume after checking Forgejo</strong>.
            Octopus does not automatically replay that uncertain write.
          </P>
          <P>
            Your Forgejo token stays on the connector machine. Code, diffs and
            review context travel to Octopus Cloud and the configured AI services.
            The connector keeps the Forgejo service private; it does not keep
            review processing on your network.
          </P>
        </section>

        <section id="forgejo-self-hosted" className="my-6 scroll-mt-24">
          <h3 className="mb-2 text-base font-semibold text-white">3. Self-hosted Octopus + private LAN/VPN</h3>
          <P>
            Run your own Octopus web application and review workers where both
            can reach Forgejo. Enable self-host mode and explicitly allow the
            exact HTTPS origin through <code>FORGEJO_ALLOWED_PRIVATE_ORIGINS</code>.
            This direct connection does not require the local connector.
          </P>
          <ol className="mb-3 list-outside list-decimal space-y-2 pl-5 text-sm text-[#888]">
            <li>Follow the <a href="/docs/self-hosting#forgejo" className="text-cyan-400 underline">self-hosted network, DNS and certificate setup</a> on both web and review workers.</li>
            <li>In your Octopus Settings → Integrations → Forgejo, choose <strong className="text-[#ccc]">Direct HTTPS from self-hosted Octopus</strong> and enter the private HTTPS origin and personal access token. Connect and sync repositories.</li>
            <li>Add signed webhooks targeting your own Octopus deployment. If the target is private, allow its exact host in Forgejo&apos;s <code>[webhook] ALLOWED_HOST_LIST</code>, keeping existing entries.</li>
          </ol>
          <P>Your Octopus deployment and configured AI services determine where reviews are processed. Use local AI services when processing must stay on your network.</P>
        </section>

        <section id="forgejo-webhooks" className="my-6 scroll-mt-24">
          <h3 className="mb-2 text-base font-semibold text-white">Signed webhooks and review events</h3>
          <P>
            In each synced Forgejo repository, open Settings → Webhooks → Add
            Webhook → Forgejo. Use POST, <code>application/json</code>, and the
            target URL and secret shown in Octopus. Select Pull Request events
            and keep the webhook active. Select Issue Comment events too if you
            want to request reviews with <code>@octopus</code> or <code>/octopus</code>
            in PR comments. A successful Test Delivery checks transport; a real
            pull request checks the complete review flow.
          </P>
          <P>
            With automatic reviews enabled, Octopus accepts pull_request events
            with action opened, reopened or synchronized, plus edited events
            containing changes.title.from. Removing a draft title prefix can
            trigger that title-change event. Octopus checks the current PR on
            Forgejo: only open, non-draft PRs qualify. Body-only edits do not
            trigger reviews. Automatic events skip a head with a prior review
            attempt or completed review, and cannot admit a second request while
            that head is pending, queued or reviewing.
          </P>
          <P>
            For an explicit re-review of a completed head, post a new comment
            with the complete @octopus or /octopus command, or request it from
            Octopus. Longer aliases such as @octopus-review are not accepted.
            Replaying the same signed webhook payload does not create another
            review request.
          </P>
        </section>
      </IntegrationSection>

      {/* Linear */}
      <IntegrationSection
        icon={
          <svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.77 17.64a1.06 1.06 0 0 1-.27-.93l2.32-11.1a1.06 1.06 0 0 1 .62-.76l10.4-4.7a1.06 1.06 0 0 1 .93.04l5.46 3.18a1.06 1.06 0 0 1 .5.78l.77 6.26a1.06 1.06 0 0 1-.27.87l-7.7 8.32a1.06 1.06 0 0 1-.87.34l-6.26-.44a1.06 1.06 0 0 1-.82-.52L2.77 17.64z" />
          </svg>
        }
        name="Linear"
        description="Create Linear issues directly from code review findings. Track and assign bugs discovered during reviews."
        setup={[
          "Connect Linear via OAuth from the settings page",
          "Select the default team for issue creation",
          "Create issues from any review finding with one click",
        ]}
      >
        <FeatureGrid>
          <Feature
            icon={<IconBug className="size-4" />}
            title="Issue Creation"
            description="Turn review findings into Linear issues with title, description, priority, and team assignment."
          />
          <Feature
            icon={<IconChecklist className="size-4" />}
            title="Status Tracking"
            description="Track issue status directly from the Octopus dashboard."
          />
        </FeatureGrid>
      </IntegrationSection>

      {/* Jira */}
      <IntegrationSection
        icon={
          <svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.53 2a4.46 4.46 0 0 0 4.46 4.46h1.78v1.72A4.46 4.46 0 0 0 22.23 12.64V2.84a.84.84 0 0 0-.84-.84zM6.77 6.77a4.46 4.46 0 0 0 4.46 4.46H13v1.72a4.46 4.46 0 0 0 4.46 4.46V7.61a.84.84 0 0 0-.84-.84zM2 11.53A4.46 4.46 0 0 0 6.46 16h1.78v1.72A4.46 4.46 0 0 0 12.7 22.18V12.37a.84.84 0 0 0-.84-.84z" />
          </svg>
        }
        name="Jira"
        description="Turn code review findings into Jira issues. Connect your Atlassian Cloud site to track bugs and improvements alongside your existing workflow."
        setup={[
          "Connect Jira via OAuth from the settings page",
          "Select the Atlassian site and default project for issue creation",
          "Create issues from any review finding with one click",
        ]}
      >
        <FeatureGrid>
          <Feature
            icon={<IconBug className="size-4" />}
            title="Issue Creation"
            description="Turn review findings into Jira issues with title, description, issue type, and project assignment."
          />
          <Feature
            icon={<IconChecklist className="size-4" />}
            title="Status Tracking"
            description="Track issue status directly from the Octopus dashboard without leaving the review."
          />
        </FeatureGrid>
      </IntegrationSection>

      {/* Slack */}
      <IntegrationSection
        icon={<IconBrandSlack className="size-5" />}
        name="Slack"
        description="Ask questions about your codebase and get notifications in Slack. Octopus searches your code, docs, and review history to answer."
        setup={[
          "Install the Octopus Slack app from the settings page",
          "Select channels and configure event notifications",
          "Use /octopus to ask questions about your codebase",
        ]}
      >
        <FeatureGrid>
          <Feature
            icon={<IconMessage className="size-4" />}
            title="/octopus Command"
            description="Ask questions about your codebase in any channel. Octopus searches code, docs, reviews, and knowledge base to answer."
          />
          <Feature
            icon={<IconWebhook className="size-4" />}
            title="Event Notifications"
            description="Get notified when reviews complete, repos are indexed, or knowledge documents are ready."
          />
        </FeatureGrid>
        <P>Configurable events:</P>
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            "review-requested",
            "review-completed",
            "review-failed",
            "repo-indexed",
            "repo-analyzed",
            "knowledge-ready",
          ].map((e) => (
            <span
              key={e}
              className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-xs text-[#888]"
            >
              {e}
            </span>
          ))}
        </div>
      </IntegrationSection>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function IntegrationSection({
  icon,
  name,
  description,
  setup,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  setup?: string[];
  children: React.ReactNode;
}) {
  return (
    <section id={name.toLowerCase()} className="mb-12 scroll-mt-24">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-white/[0.06] text-[#888]">
          {icon}
        </div>
        <h2 className="text-xl font-semibold text-white">{name}</h2>
      </div>
      <P>{description}</P>

      {setup && <div className="mb-4">
        <h3 className="mb-2 text-sm font-semibold text-[#ccc]">Setup</h3>
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-[#888]">
          {setup.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>}

      {children}
    </section>
  );
}

function FeatureGrid({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid gap-3 sm:grid-cols-2">{children}</div>;
}

function Feature({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-white/[0.04] text-[#888]">
        {icon}
      </div>
      <h4 className="text-sm font-medium text-white">{title}</h4>
      <p className="mt-1 text-xs leading-relaxed text-[#666]">{description}</p>
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-sm leading-relaxed text-[#888]">{children}</p>;
}
