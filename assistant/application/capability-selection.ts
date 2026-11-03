import { runSelection } from "./selection-orchestrator";

type CapabilitySelectionInput = Parameters<typeof runSelection>[0];

export async function generateCapabilitySelection(
  input: string | CapabilitySelectionInput,
): ReturnType<typeof runSelection> {
  if (typeof input === "string") {
    return runSelection({ extractionId: input });
  }

  return runSelection(input);
}
