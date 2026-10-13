import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, isSeq, isMap } from "yaml";
import { getPreset } from "./presets.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export async function installGitHubCapture(
  workflow: string,
  job: string,
  preset: string,
  ref: string,
  state: string,
): Promise<void> {
  getPreset(preset);
  if (!/^[a-f0-9]{40}$/.test(ref))
    throw new Error(
      "--ref must be the full commit SHA of a published, built capture action.",
    );
  const original = await readFile(workflow, "utf8");
  const document = parseDocument(original, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid workflow YAML: ${document.errors[0]!.message}`);
  const steps = document.getIn(["jobs", job, "steps"]);
  if (!isSeq(steps))
    throw new Error(`Job ${job} has no steps in this workflow.`);
  if (
    steps.items.some(
      (step) => isMap(step) && step.get("id") === "plagiarize-capture",
    )
  )
    throw new Error("Capture is already installed in this job.");
  // Snapshot after runtime setup and before application shell steps.
  let position = 0;
  for (const [index, step] of steps.items.entries()) {
    const uses = isMap(step) ? String(step.get("uses") ?? "") : "";
    if (
      uses.startsWith("actions/checkout@") ||
      uses.startsWith("actions/setup-node@")
    )
      position = index + 1;
  }
  steps.items.splice(
    position,
    0,
    document.createNode({
      name: "Capture replay environment",
      id: "plagiarize-capture",
      uses: `turnerburchard/plagiarize@${ref}`,
      with: { preset, matrix: "${{ toJSON(matrix) }}" },
    }),
  );
  await mkdir(join(state, "backups"), { recursive: true, mode: 0o700 });
  await writeFile(join(state, "backups", `${randomUUID()}.yml`), original, {
    mode: 0o600,
  });
  await writeFile(workflow, document.toString());
}
