import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { execute, type Executor } from "../core/process.js";
import { readManifest } from "../core/files.js";
import { parseManifest, type Manifest } from "../core/manifest.js";
import { gitSource } from "./capture.js";
import { baselineGaps, getPreset, presetForLabels } from "./presets.js";
import {
  extractJob,
  workflowJobIds,
  type WorkflowContext,
} from "./workflow.js";

const runSchema = z.object({
  id: z.number(),
  run_attempt: z.number(),
  head_sha: z.string(),
  path: z.string(),
  event: z.string(),
  head_branch: z.string().nullable(),
  repository: z.object({ full_name: z.string() }),
});
const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  conclusion: z.string().nullable(),
  labels: z.array(z.string()),
  steps: z
    .array(z.object({ name: z.string(), conclusion: z.string().nullable() }))
    .default([]),
});
type Job = z.infer<typeof jobSchema>;
export interface GitHubSelection {
  url?: string;
  latestFailure?: boolean;
  cwd: string;
  job?: string;
  preset?: string;
  node?: string;
  matrix?: WorkflowContext["matrix"];
}

export function parseRunUrl(input: string): {
  repository: string;
  runId: string;
} {
  const url = new URL(input);
  const match = url.pathname.match(
    /^\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)\/?$/,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw new Error("Expected https://github.com/owner/repo/actions/runs/123");
  return { repository: match[1]!, runId: match[2]! };
}

export function artifactName(
  job: string,
  runId: string,
  attempt: number,
): string {
  return `plagiarize-${runId}-${attempt}-${job}`;
}

export class GitHubProvider {
  constructor(private readonly run: Executor = execute) {}
  private async api(path: string): Promise<unknown> {
    return JSON.parse((await this.run("gh", ["api", path])).stdout);
  }
  private async pages(
    path: string,
    key: "jobs" | "artifacts",
  ): Promise<unknown[]> {
    const pages: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.api(`${path}&page=${page}`);
      const rows = z.object({ [key]: z.array(z.unknown()) }).parse(response)[
        key
      ]!;
      pages.push(response);
      if (rows.length < 100) return pages;
    }
    throw new Error(
      "GitHub response exceeded the 10,000-item pagination limit.",
    );
  }
  async import(selection: GitHubSelection): Promise<Manifest> {
    let reference: { repository: string; runId: string };
    if (selection.url) reference = parseRunUrl(selection.url);
    else {
      if (!selection.latestFailure)
        throw new Error("Supply a run URL or --latest-failure.");
      const source = await gitSource(selection.cwd, this.run);
      const branch = (
        await this.run("git", ["branch", "--show-current"], {
          cwd: selection.cwd,
        })
      ).stdout.trim();
      if (!branch)
        throw new Error(
          "Detached checkout: supply a run URL to avoid selecting the wrong branch.",
        );
      const response = z
        .object({ workflow_runs: z.array(runSchema) })
        .parse(
          await this.api(
            `repos/${source.repository}/actions/runs?status=failure&branch=${encodeURIComponent(branch)}&per_page=1`,
          ),
        );
      if (!response.workflow_runs[0])
        throw new Error(`No failed GitHub run found for branch ${branch}.`);
      reference = {
        repository: source.repository,
        runId: String(response.workflow_runs[0].id),
      };
    }
    const base = `repos/${reference.repository}/actions/runs/${reference.runId}`;
    const metadata = runSchema.parse(await this.api(base));
    const pages = await this.pages(
      `${base}/attempts/${metadata.run_attempt}/jobs?per_page=100`,
      "jobs",
    );
    const jobs = pages.flatMap(
      (page) => z.object({ jobs: z.array(jobSchema) }).parse(page).jobs,
    );
    const candidates = selection.job
      ? jobs.filter(
          (job) =>
            String(job.id) === selection.job || job.name === selection.job,
        )
      : jobs.filter((job) => job.conclusion === "failure");
    if (candidates.length !== 1)
      throw new Error(
        `Choose one job with --job (name or numeric ID). Available jobs: ${jobs.map((job) => `${job.id}: ${job.name}`).join(", ")}`,
      );
    const selected = candidates[0]!;
    const artifactPages = await this.pages(
      `${base}/artifacts?per_page=100`,
      "artifacts",
    );
    const artifacts = artifactPages.flatMap(
      (page) =>
        z
          .object({
            artifacts: z.array(
              z.object({
                name: z.string(),
                expired: z.boolean(),
                size_in_bytes: z.number(),
              }),
            ),
          })
          .parse(page).artifacts,
    );
    const prefix = `plagiarize-${metadata.id}-${metadata.run_attempt}-`;
    const captures = artifacts.filter(
      (artifact) =>
        artifact.name.startsWith(prefix) &&
        !artifact.expired &&
        artifact.size_in_bytes <= 2_000_000,
    );
    for (const artifact of captures) {
      const directory = await mkdtemp(join(tmpdir(), "plagiarize-artifact-"));
      try {
        await this.run("gh", [
          "run",
          "download",
          String(metadata.id),
          "--repo",
          reference.repository,
          "--name",
          artifact.name,
          "--dir",
          directory,
        ]);
        const manifest = await readManifest(join(directory, "manifest.json"));
        if (
          manifest.source.repository !== reference.repository ||
          manifest.source.commit !== metadata.head_sha ||
          manifest.github?.runId !== String(metadata.id) ||
          manifest.github.attempt !== metadata.run_attempt
        )
          throw new Error(
            "Capture identity does not match the selected GitHub run.",
          );
        if (manifest.job.name !== selected.name) continue;
        return this.withOutcome(manifest, selected);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    // Old runs can still be imported, but uncertainty is retained as gaps rather than guessed away.
    const path = metadata.path.split("@")[0]!;
    if (
      !/^\.github\/workflows\/[\w./-]+\.ya?ml$/.test(path) ||
      path.split("/").includes("..")
    )
      throw new Error("Unsupported workflow path from GitHub.");
    const content = z
      .object({ content: z.string(), encoding: z.literal("base64") })
      .parse(
        await this.api(
          `repos/${reference.repository}/contents/${path}?ref=${metadata.head_sha}`,
        ),
      );
    const yaml = Buffer.from(content.content, "base64").toString("utf8");
    const ids = workflowJobIds(yaml);
    const preset = selection.preset
      ? getPreset(selection.preset)
      : presetForLabels(selected.labels);
    const context: WorkflowContext = {
      github: {
        sha: metadata.head_sha,
        repository: reference.repository,
        event_name: metadata.event,
        run_id: String(metadata.id),
        workspace: "/workspace",
      },
    };
    if (selection.node) context.nodeVersion = selection.node;
    if (selection.matrix) context.matrix = selection.matrix;
    const extracted = ids.map((id) => extractJob(yaml, id, context));
    const matches = extracted.filter(
      (job) => job.name === selected.name || job.id === selected.name,
    );
    if (matches.length !== 1)
      throw new Error(
        "Could not map the selected GitHub job to a workflow job. Install the capture action to preserve job identity.",
      );
    const job = matches[0]!;
    const runner: Manifest["runner"] = {
      preset: preset.id,
      image: job.image ?? preset.image,
      platform: selected.labels.some((label) => /arm64/.test(label))
        ? "linux/arm64"
        : "linux/amd64",
      observed: {},
    };
    if (selection.node) runner.node = selection.node;
    const manifest = parseManifest({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      provider: preset.provider,
      source: { repository: reference.repository, commit: metadata.head_sha },
      runner,
      job: { id: job.id, name: job.name, steps: job.steps },
      expected: { conclusion: "unknown" },
      github: {
        runId: String(metadata.id),
        attempt: metadata.run_attempt,
        jobId: selected.id,
      },
      gaps: [
        ...baselineGaps(preset),
        ...job.gaps,
        {
          code: "retrospective-import",
          message:
            "No capture artifact: runner image release and original installed tools are unknown.",
          blocking: false,
        },
        ...(metadata.event === "pull_request"
          ? [
              {
                code: "pull-request-context",
                message:
                  "The original pull request ref and event payload were not captured.",
                blocking: false,
              },
            ]
          : []),
      ],
    });
    return this.withOutcome(manifest, selected);
  }
  private withOutcome(manifest: Manifest, job: Job): Manifest {
    manifest.github!.jobId = job.id;
    manifest.expected.conclusion =
      job.conclusion === "failure"
        ? "failure"
        : job.conclusion === "success"
          ? "success"
          : "unknown";
    const failed = job.steps.find((step) => step.conclusion === "failure");
    if (failed) {
      const matches = manifest.job.steps.filter(
        (step) => step.name === failed.name,
      );
      if (matches.length === 1) manifest.expected.failingStep = matches[0]!.id;
      else
        manifest.gaps.push({
          code: "failure-not-shell-step",
          message: `Original failure "${failed.name}" is not a uniquely captured shell step.`,
          blocking: true,
        });
    }
    return parseManifest(manifest);
  }
}
