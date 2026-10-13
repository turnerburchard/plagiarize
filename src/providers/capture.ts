import { readFile } from "node:fs/promises";
import { platform, arch, release } from "node:os";
import { resolve } from "node:path";
import { execute, type Executor } from "../core/process.js";
import { parseManifest, stepSchema, type Manifest } from "../core/manifest.js";
import { getPreset, baselineGaps } from "./presets.js";
import {
  extractJob,
  workflowJobIds,
  type WorkflowContext,
} from "./workflow.js";

export interface CaptureOptions {
  cwd: string;
  preset: string;
  workflow?: string;
  job?: string;
  command?: string;
  node?: string;
  image?: string;
  matrix?: WorkflowContext["matrix"];
  expected?: Manifest["expected"]["conclusion"];
}

export async function gitSource(
  cwd: string,
  run: Executor = execute,
): Promise<Manifest["source"]> {
  const commit = (
    await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd })
  ).stdout.trim();
  const origin = (
    await run("git", ["remote", "get-url", "origin"], { cwd })
  ).stdout.trim();
  const match = origin.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
  );
  if (!match)
    throw new Error(
      "The source checkout needs a GitHub origin remote. Embedded credentials and other hosts are unsupported.",
    );
  return { repository: match[1]!, commit };
}

export async function capture(
  options: CaptureOptions,
  env: NodeJS.ProcessEnv = process.env,
  run: Executor = execute,
): Promise<Manifest> {
  const preset = getPreset(options.preset);
  const source = await gitSource(options.cwd, run);
  const detected = await run("node", ["--version"], {
    cwd: options.cwd,
    check: false,
  });
  const node =
    options.node ??
    (detected.code === 0
      ? detected.stdout.trim().replace(/^v/, "")
      : undefined);
  const runner: Manifest["runner"] = {
    preset: preset.id,
    image: options.image ?? preset.image,
    platform: arch() === "arm64" ? "linux/arm64" : "linux/amd64",
    observed: { os: platform(), architecture: arch(), kernel: release() },
  };
  if (node) runner.node = node;
  // Deliberately whitelist non-secret runner metadata rather than snapshotting process.env.
  for (const key of [
    "ImageOS",
    "ImageVersion",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "CODEBUILD_BUILD_IMAGE",
  ]) {
    if (env[key]) runner.observed[key] = env[key]!;
  }
  const gaps = baselineGaps(preset);
  let job: Manifest["job"];
  if (options.workflow) {
    const yaml = await readFile(resolve(options.cwd, options.workflow), "utf8");
    const ids = workflowJobIds(yaml);
    const id =
      options.job ?? env.GITHUB_JOB ?? (ids.length === 1 ? ids[0] : undefined);
    if (!id)
      throw new Error(
        `Choose a workflow job with --job. Available jobs: ${ids.join(", ")}`,
      );
    const context: WorkflowContext = {
      github: {
        repository: source.repository,
        sha: source.commit,
        workspace: "/workspace",
        ...(env.GITHUB_REF ? { ref: env.GITHUB_REF } : {}),
        ...(env.GITHUB_EVENT_NAME ? { event_name: env.GITHUB_EVENT_NAME } : {}),
        ...(env.GITHUB_RUN_ID ? { run_id: env.GITHUB_RUN_ID } : {}),
      },
    };
    if (node) context.nodeVersion = node;
    if (options.matrix) context.matrix = options.matrix;
    const extracted = extractJob(yaml, id, context);
    job = { id, name: extracted.name, steps: extracted.steps };
    gaps.push(...extracted.gaps);
    if (extracted.image) runner.image = extracted.image;
    if (!env.GITHUB_ACTIONS)
      gaps.push({
        code: "local-workflow-context",
        message:
          "Workflow captured outside GitHub: event context may be incomplete.",
        blocking: false,
      });
  } else {
    if (!options.command)
      throw new Error(
        "Supply --workflow or --command to capture executable steps.",
      );
    job = {
      id: options.job ?? "local",
      name: options.job ?? "local",
      steps: [
        stepSchema.parse({
          id: "command",
          name: "Captured command",
          run: options.command,
        }),
      ],
    };
  }
  if (runner.observed.os !== "linux")
    gaps.push({
      code: "different-os",
      message:
        "This snapshot was not captured on Linux; replay uses a Linux container.",
      blocking: false,
    });
  const manifest: Manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    provider: preset.provider,
    source,
    runner,
    job,
    expected: { conclusion: options.expected ?? "unknown" },
    gaps,
  };
  if (env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT)
    manifest.github = {
      runId: env.GITHUB_RUN_ID,
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    };
  return parseManifest(manifest);
}
