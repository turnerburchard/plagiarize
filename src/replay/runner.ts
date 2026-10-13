import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { execute, type Executor } from "../core/process.js";
import { writeJson, readJson } from "../core/files.js";
import {
  assertReplayable,
  variableName,
  type Manifest,
} from "../core/manifest.js";
import { DockerEnvironment } from "./docker.js";
import { prepareWorkspace, within } from "./workspace.js";
import { dockerNetwork } from "./network.js";

export const resultSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    manifestPath: z.string(),
    directory: z.string(),
    container: z.string().regex(/^plagiarize-[a-f0-9-]{36}$/),
    image: z.string(),
    workingTree: z.boolean(),
    exitCode: z.number().int(),
    reproduced: z.boolean().nullable(),
    match: z.enum([
      "same-step-and-outcome",
      "outcome-only",
      "different",
      "unknown",
    ]),
    steps: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        exitCode: z.number().int(),
        log: z.string(),
      }),
    ),
    gaps: z.array(z.string()),
  })
  .strict();
export type ReplayResult = z.infer<typeof resultSchema>;
export interface ReplayOptions {
  cwd: string;
  state: string;
  workingTree?: boolean;
  env?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function compareOutcome(
  manifest: Manifest,
  steps: ReplayResult["steps"],
): Pick<ReplayResult, "match" | "reproduced"> {
  if (manifest.expected.conclusion === "unknown")
    return { match: "unknown", reproduced: null };
  const failed = steps.find((step) => step.exitCode !== 0);
  const sameOutcome =
    (manifest.expected.conclusion === "failure") === Boolean(failed);
  if (!sameOutcome) return { match: "different", reproduced: false };
  if (manifest.expected.failingStep) {
    const same = failed?.id === manifest.expected.failingStep;
    return {
      match: same ? "same-step-and-outcome" : "different",
      reproduced: same,
    };
  }
  return { match: "outcome-only", reproduced: true };
}

export class ReplayRunner {
  constructor(
    private readonly run: Executor = execute,
    private readonly environments: Pick<
      DockerEnvironment,
      "prepare"
    > = new DockerEnvironment(run),
  ) {}
  async replay(
    manifest: Manifest,
    options: ReplayOptions,
  ): Promise<ReplayResult> {
    assertReplayable(manifest);
    const allowed = new Set(options.env ?? []);
    for (const name of allowed) variableName.parse(name);
    for (const step of manifest.job.steps)
      for (const value of Object.values(step.env)) {
        if (
          "external" in value &&
          (!allowed.has(value.external) ||
            process.env[value.external] === undefined)
        )
          throw new Error(
            `Required input ${value.external} is missing. Set it locally and opt in with --env ${value.external}.`,
          );
      }
    const environment = await this.environments.prepare(
      manifest,
      options.state,
      options.signal,
    );
    const runId = randomUUID(),
      container = `plagiarize-${runId}`;
    const directory = join(options.state, "runs", runId),
      workspace = join(directory, "workspace"),
      scripts = join(directory, "scripts");
    await mkdir(scripts, { recursive: true, mode: 0o700 });
    const statuses = join(directory, "status");
    await mkdir(statuses, { mode: 0o700 });
    const manifestPath = join(directory, "manifest.json");
    await writeJson(manifestPath, manifest);
    await prepareWorkspace(
      manifest,
      workspace,
      options.cwd,
      options.workingTree ?? false,
      this.run,
    );
    for (const step of manifest.job.steps) {
      await writeFile(join(scripts, `${step.id}.sh`), step.run + "\n", {
        mode: 0o600,
      });
    }
    const commandOptions = options.signal ? { signal: options.signal } : {};
    const steps: ReplayResult["steps"] = [];
    let created = false,
      completed = false;
    try {
      const network = await dockerNetwork();
      created = true;
      await this.run(
        "docker",
        [
          "create",
          "--name",
          container,
          "--platform",
          manifest.runner.platform,
          "--init",
          ...network.hosts.flatMap((host) => ["--add-host", host]),
          ...network.names.flatMap((name) => ["--env", name]),
          "--env",
          "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
          "--mount",
          `type=bind,source=${workspace},target=/workspace`,
          "--mount",
          `type=bind,source=${scripts},target=/plagiarize,readonly`,
          "--mount",
          `type=bind,source=${statuses},target=/plagiarize-status`,
          environment.imageId,
        ],
        commandOptions,
      );
      await this.run("docker", ["start", container], commandOptions);
      for (const step of manifest.job.steps) {
        // Earlier steps may create a directory; validate cwd immediately before its use.
        const target = await realpath(
          resolve(workspace, step.workingDirectory),
        );
        if (!within(await realpath(workspace), target))
          throw new Error(
            `Step ${step.id} working directory escapes the workspace.`,
          );
        const env: NodeJS.ProcessEnv = { ...process.env };
        const names = new Set(allowed);
        for (const [name, value] of Object.entries(step.env)) {
          env[name] =
            "value" in value ? value.value : process.env[value.external];
          names.add(name);
        }
        for (const [name, value] of Object.entries({
          GITHUB_WORKSPACE: "/workspace",
          GITHUB_SHA: manifest.source.commit,
          GITHUB_REPOSITORY: manifest.source.repository,
          CI: "true",
        })) {
          if (!(name in step.env)) {
            env[name] = value;
            names.add(name);
          }
        }
        const log = join(directory, `${step.id}.log`);
        const result = await this.run(
          "docker",
          [
            "exec",
            "--workdir",
            `/workspace/${step.workingDirectory}`,
            ...[...names].flatMap((name) => ["--env", name]),
            container,
            "bash",
            "--noprofile",
            "--norc",
            "-c",
            'bash --noprofile --norc -e -o pipefail "$1"; status=$?; printf "%s\\n" "$status" > "$2"; exit "$status"',
            "--",
            `/plagiarize/${step.id}.sh`,
            `/plagiarize-status/${step.id}`,
          ],
          {
            ...commandOptions,
            env,
            logFile: log,
            check: false,
            timeoutMs: options.timeoutMs ?? 1_800_000,
          },
        );
        let recorded: string;
        try {
          recorded = (await readFile(join(statuses, step.id), "utf8")).trim();
        } catch {
          throw new Error(
            `Step ${step.id} did not record an exit status; Docker execution failed. See ${log}.`,
          );
        }
        if (!/^\d{1,3}$/.test(recorded) || Number(recorded) !== result.code)
          throw new Error(
            `Step ${step.id} exit status disagrees with Docker. See ${log}.`,
          );
        steps.push({
          id: step.id,
          name: step.name,
          exitCode: result.code,
          log,
        });
        if (result.code !== 0) break;
      }
      completed = true;
    } finally {
      if (created) {
        await this.run("docker", ["stop", "--time", "1", container], {
          check: false,
        });
        if (!completed)
          await this.run("docker", ["rm", "--force", container], {
            check: false,
          });
      }
    }
    const result: ReplayResult = {
      schemaVersion: 1,
      runId,
      manifestPath,
      directory,
      container,
      image: environment.imageId,
      workingTree: options.workingTree ?? false,
      exitCode: steps.find((step) => step.exitCode !== 0)?.exitCode ?? 0,
      ...compareOutcome(manifest, steps),
      steps,
      gaps: manifest.gaps.map((gap) => gap.message),
    };
    await writeJson(join(directory, "result.json"), result);
    await writeJson(join(options.state, "last.json"), result);
    return result;
  }
}

export async function lastResult(state: string): Promise<ReplayResult> {
  return resultSchema.parse(await readJson(join(state, "last.json")));
}
