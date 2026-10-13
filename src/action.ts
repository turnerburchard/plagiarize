import * as core from "@actions/core";
import { DefaultArtifactClient } from "@actions/artifact";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "./providers/capture.js";
import { artifactName } from "./providers/github.js";
import { writeJson } from "./core/files.js";
import { fingerprint } from "./core/manifest.js";
import { z } from "zod";

try {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
  const path = ref.match(/^[\w.-]+\/[\w.-]+\/(\.github\/workflows\/.+?)@/)?.[1];
  if (!path || !process.env.GITHUB_WORKSPACE)
    throw new Error("Capture must run in GitHub Actions after checkout.");
  const matrix = z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .parse(JSON.parse(core.getInput("matrix") || "{}"));
  const observedImage = process.env.ImageOS;
  const preset =
    core.getInput("preset") ||
    (observedImage === "ubuntu22"
      ? "github/ubuntu-22.04"
      : "github/ubuntu-24.04");
  const manifest = await capture({
    cwd: process.env.GITHUB_WORKSPACE,
    preset,
    workflow: path,
    matrix,
  });
  if (!manifest.github) throw new Error("GitHub run identity is missing.");
  const directory = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "plagiarize-capture-"),
  );
  const file = join(directory, "manifest.json");
  await writeJson(file, manifest);
  const suffix = Object.keys(matrix).length
    ? `-${fingerprint(matrix).slice(0, 12)}`
    : "";
  const name =
    artifactName(
      manifest.job.id,
      manifest.github.runId,
      manifest.github.attempt,
    ) + suffix;
  await new DefaultArtifactClient().uploadArtifact(name, [file], directory, {
    retentionDays: 14,
  });
  core.setOutput("artifact-name", name);
  core.setOutput("manifest", file);
  const command = `plagiarize reproduce https://github.com/${manifest.source.repository}/actions/runs/${manifest.github.runId}`;
  await core.summary
    .addHeading("Replay this run locally")
    .addCodeBlock(command, "sh")
    .addRaw(
      `\nCaptured ${manifest.job.steps.length} shell steps; ${manifest.gaps.filter((gap) => gap.blocking).length} replay blockers. Inspect the capture before claiming faithful reproduction.\n`,
    )
    .write();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
