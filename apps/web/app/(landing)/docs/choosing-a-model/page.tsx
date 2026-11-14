import Link from "@/components/link";
import { IconAdjustments } from "@tabler/icons-react";
import { DocsJsonLd } from "../docs-json-ld";

export const metadata = {
  title: "Which model should review your code",
  description:
    "How to pick a review model in Octopus: what each model cost per review over 30 days of real use, when to choose which, and where to switch.",
  alternates: {
    canonical: "https://octopus-review.ai/docs/choosing-a-model",
  },
};

// Median amount charged per review on Octopus Cloud (platform keys, 2x rate
// included) over the 30 days up to 14 November 2026, with the middle half.
const COSTS: Array<[model: string, median: string, middleHalf: string]> = [
  ["Claude Haiku 4.5", "$0.09", "$0.07 to $0.11"],
  ["GPT-5.3 Codex", "$0.16", "$0.15 to $0.19"],
  ["Qwen3.8-Max", "$0.17", "$0.14 to $0.22"],
  ["Claude Sonnet 5.5", "$0.42", "$0.23 to $0.64"],
  ["Claude Opus 5.5 (Cloud default)", "$0.76", "$0.57 to $0.98"],
  ["Claude Opus 5", "$1.03", "$0.73 to $1.41"],
  ["Claude Fable 5.2", "$1.52", "$1.19 to $2.13"],
  ["GPT-6 Astra", "$1.67", "$1.54 to $2.33"],
  ["Claude Fable 5.1", "$2.38", "$1.98 to $3.10"],
];

export default function ChoosingAModelPage() {
  return (
    <article className="max-w-3xl">
      <DocsJsonLd title={metadata.title} description={metadata.description} path="/docs/choosing-a-model" crumb="Choosing a model" />
      <div className="mb-8">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#555]">
          <IconAdjustments className="size-4" />
          Models
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Which model should review your code
        </h1>
        <p className="mt-3 text-sm text-[#888]">
          Octopus lets you choose the model that reviews your pull requests, for
          a whole organisation or for a single repository. This guide covers
          what the choice changes and what each model has cost per review. It
          ends with how to switch.
        </p>
      </div>

      <Section title="What changes when you change the model">
        <UL>
          <li>
            <strong>Cost per review.</strong> Octopus Cloud bills AI usage at 2x
            the provider&apos;s list price. Among the models below, list prices
            run from $1 to $10 per 1M input tokens.
          </li>
          <li>
            <strong>How long a review takes.</strong> Most reviews finish in 30
            to 90 seconds, and a pull request with hundreds of files can take a
            few minutes. Higher reasoning effort means a slower review.
          </li>
          <li>
            <strong>How much reasoning goes into it.</strong> Some models think
            before they answer. The Reasoning Effort setting controls how hard
            those models reason. Models without extended thinking ignore it.
          </li>
        </UL>
      </Section>

      <Section title="What each model cost per review">
        <P>
          These are the median amounts charged per review on Octopus Cloud over
          the 30 days up to 14 November 2026. They cover reviews on platform
          keys and include the 2x platform rate. The last column is the range
          that holds the middle half of reviews.
        </P>
        <div className="mb-4 overflow-x-auto rounded-lg border border-white/[0.06]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-left">
                <th className="px-4 py-2 font-medium text-[#999]">Model</th>
                <th className="px-4 py-2 text-right font-medium text-[#999]">Median per review</th>
                <th className="px-4 py-2 text-right font-medium text-[#999]">Middle half of reviews</th>
              </tr>
            </thead>
            <tbody>
              {COSTS.map(([model, median, middleHalf], index) => (
                <tr key={model} className={index === COSTS.length - 1 ? "" : "border-b border-white/[0.06]"}>
                  <td className="px-4 py-2 text-[#ccc]">{model}</td>
                  <td className="px-4 py-2 text-right text-[#888]">{median}</td>
                  <td className="px-4 py-2 text-right text-[#888]">{middleHalf}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>
          This is cost data, not quality data: we have not measured which model
          finds more problems, so nothing here ranks the models on review
          quality. Each model reviewed the pull requests its own users sent it,
          so the rows are not a test on identical pull requests. Your figures
          will depend on the size of your changes.
        </P>
      </Section>

      <Section title="Which model to pick">
        <UL>
          <li>
            If you have no reason to change, keep the Cloud default, Claude
            Opus 5.5.
          </li>
          <li>
            If a repository opens many pull requests and cost matters most,
            give it a cheaper model. Claude Haiku 4.5, GPT-5.3 Codex and
            Qwen3.8-Max each had a median below $0.20 per review. Claude
            Sonnet 5.5 came in at $0.42.
          </li>
          <li>
            If you want the deepest review, for example on security-sensitive
            code, pick a Fable model. Fable is the tier Anthropic places above
            Opus. Fable 5.2 has the lower list price of the two: $8 input and
            $40 output per 1M tokens, against $10 and $50 for Fable 5.1.
          </li>
          <li>
            If a pull request is very large, Claude Fable 5.2 and Fable 5.1 can
            review the complete change instead of a shortened diff, as long as
            the change fits the size, cost and time limits for a single review.
          </li>
          <li>
            If you already pay a provider, add your own API key. Octopus sends
            requests through your key and deducts no credits for them, and the
            provider bills you. Other platform operations, such as embeddings,
            still use credits.
          </li>
        </UL>
      </Section>

      <Section title="How to switch">
        <P>Open Settings and choose Models, under AI &amp; Reviews.</P>
        <UL>
          <li>
            <strong>For the whole organisation:</strong> in Organization
            Defaults, pick a Review &amp; Chat Model. Reasoning Effort is in the
            same card.
          </li>
          <li>
            <strong>For one repository:</strong> in Repository Models, find the
            repository and pick its Review &amp; Chat Model. This overrides the
            organisation default.
          </li>
          <li>
            <strong>For your own key:</strong> add it under Provider Keys, next
            to Models in Settings.
          </li>
        </UL>
        <P>
          A repository without its own model uses the organisation default.
          Provider list prices for every model are on the{" "}
          <Link href="/docs/pricing" className="text-white underline decoration-white/30 underline-offset-2 hover:decoration-white">
            pricing page
          </Link>
          .
        </P>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-sm leading-relaxed text-[#888]">{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return <ul className="mb-3 list-outside list-disc space-y-2 pl-5 text-sm leading-relaxed text-[#888]">{children}</ul>;
}
