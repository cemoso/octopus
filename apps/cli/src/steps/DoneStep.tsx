import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { loadConfig, saveConfig, type OctopusConfig } from "../lib/config.js";

export type DoneStepProps = {
  answers: Partial<OctopusConfig>;
};

type Phase = "saving" | "done" | "failed";

/**
 * Final step: persists the accumulated answers and tells the user they're set.
 * Save happens in a useEffect on mount; the screen reflects the phase so a
 * filesystem failure surfaces inline rather than crashing the wizard.
 */
export function DoneStep({ answers }: DoneStepProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("saving");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const current = await loadConfig();
        await saveConfig({ ...current, ...answers });
        setPhase("done");
        // Give the user a beat to see the success line before exiting.
        setTimeout(exit, 600);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      }
    })();
  }, [answers, exit]);

  if (phase === "saving") {
    return (
      <Box flexDirection="column">
        <Text>Saving preferences…</Text>
      </Box>
    );
  }

  if (phase === "failed") {
    return (
      <Box flexDirection="column">
        <Text color="red" bold>Could not save preferences:</Text>
        <Text color="red">{error}</Text>
        <Text> </Text>
        <Text dimColor>Check that ~/.octopus is writable, then re-run the wizard.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="green" bold>You're set 🐙</Text>
      <Text> </Text>
      <Text>Next steps:</Text>
      <Text>  • Open a pull request — Octopus will review it automatically.</Text>
      <Text>  • Run `octp review &lt;PR&gt;` to trigger a review on demand.</Text>
      <Text>  • Re-run this wizard any time with `octp onboard --reset`.</Text>
    </Box>
  );
}
