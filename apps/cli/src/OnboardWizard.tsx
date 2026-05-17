import React, { useMemo, useState } from "react";
import { Box } from "ink";
import { Header } from "./components/Header.js";
import { WelcomeStep } from "./steps/WelcomeStep.js";
import { AuthStep } from "./steps/AuthStep.js";
import { OrgStep } from "./steps/OrgStep.js";
import { ProviderStep } from "./steps/ProviderStep.js";
import { ModelStep } from "./steps/ModelStep.js";
import { ByokStep } from "./steps/ByokStep.js";
import { ValidateStep } from "./steps/ValidateStep.js";
import { DoneStep } from "./steps/DoneStep.js";
import type { OctopusConfig } from "./lib/config.js";

/**
 * Linear wizard with conditional skips via useMemo<StepKey[]>. Each step is
 * a small component that calls `onNext(answers)` when the user advances; the
 * wizard owns the answer accumulator and the step index. Add a new step by
 * (1) adding a key to StepKey, (2) appending the component to the switch
 * below, and (3) including/excluding it in the sequence useMemo based on
 * environment (self-hosted vs hosted, etc.).
 *
 * Real steps land progressively. Welcome → Auth → Org → Done is shipping now;
 * Provider / Model / BYOK / Validate / Repo install land in follow-up PRs
 * tracked under Workstream 7.
 */
export type StepKey =
  | "welcome"
  | "auth"
  | "org"
  | "provider"
  | "model"
  | "byok"
  | "validate"
  | "done";

const STEPS: { key: StepKey; label: string }[] = [
  { key: "welcome", label: "Welcome" },
  { key: "auth", label: "Auth" },
  { key: "org", label: "Org" },
  { key: "provider", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "byok", label: "BYOK" },
  { key: "validate", label: "Validate" },
  { key: "done", label: "Done" },
];

export function OnboardWizard() {
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Partial<OctopusConfig>>({});

  // Conditional sequence. In later phases this returns a subset based on
  // hosted-vs-self-hosted, presence of an existing org, etc.
  const sequence = useMemo<StepKey[]>(() => STEPS.map((s) => s.key), []);

  const activeKey = sequence[stepIndex];
  const headerSteps = useMemo(
    () => STEPS.filter((s) => sequence.includes(s.key)),
    [sequence],
  );

  const next = (patch: Partial<OctopusConfig> = {}) => {
    setAnswers((a) => ({ ...a, ...patch }));
    setStepIndex((i) => Math.min(i + 1, sequence.length - 1));
  };

  // Jump back to a specific step key. Used by OrgStep → Auth ("switch org").
  const jumpTo = (key: StepKey) => {
    const idx = sequence.indexOf(key);
    if (idx >= 0) setStepIndex(idx);
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Header steps={headerSteps} activeKey={activeKey} />
      {activeKey === "welcome" && <WelcomeStep onNext={() => next()} />}
      {activeKey === "auth" && <AuthStep onNext={(p) => next(p)} />}
      {activeKey === "org" && <OrgStep onNext={() => next()} onSwitchOrg={() => jumpTo("auth")} />}
      {activeKey === "provider" && <ProviderStep onNext={(p) => next(p)} />}
      {activeKey === "model" && (
        <ModelStep provider={answers.provider ?? ""} onNext={(p) => next(p)} />
      )}
      {activeKey === "byok" && (
        <ByokStep provider={answers.provider ?? ""} onNext={() => next()} />
      )}
      {activeKey === "validate" && (
        <ValidateStep
          provider={answers.provider ?? ""}
          onNext={() => next()}
          onEditKey={() => jumpTo("byok")}
        />
      )}
      {activeKey === "done" && <DoneStep answers={answers} />}
    </Box>
  );
}
