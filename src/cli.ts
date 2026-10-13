#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { capture, type CaptureOptions } from "./providers/capture.js";
import { GitHubProvider, type GitHubSelection } from "./providers/github.js";
import { presets } from "./providers/presets.js";
import { installGitHubCapture } from "./providers/install.js";
import { readManifest, writeJson } from "./core/files.js";
import { requiredInputs } from "./core/manifest.js";
import { execute } from "./core/process.js";
import { errorMessage } from "./core/errors.js";
import { ReplayRunner, lastResult, compareOutcome } from "./replay/runner.js";

const help = `Plagiarize — capture CI, replay locally\n\nUsage:\n  plagiarize presets [--json]\n  plagiarize init --preset github/ubuntu-24.04 --command 'npm ci && npm test'\n  plagiarize capture --workflow .github/workflows/ci.yml --job test\n  plagiarize capture install github --workflow .github/workflows/ci.yml --job test --ref <action-sha>\n  plagiarize import <run-url> [--job <name-or-id>]\n  plagiarize reproduce [<run-url>] [--latest-failure] [--json]\n  plagiarize rerun --working-tree [--json]\n  plagiarize inspect [--json]\n  plagiarize compare [--json]\n  plagiarize shell\n\nOptions:\n  --file <path>     Capture path (default: .plagiarize/manifest.json)\n  --state <path>    Local state directory (default: .plagiarize at repository root)\n  --cwd <path>      Source checkout\n  --preset <id>    Provider/environment baseline\n  --node <x.y.z>   Exact Node version for retrospective imports or captures\n  --matrix <json>  Resolved matrix values\n  --env <NAME>     Explicitly pass a local environment variable (repeatable)\n  --timeout <sec>  Per-step timeout (default: 1800)\n  --json           Machine-readable stdout; replay exits with the job exit code\n\nReplays execute repository code in Docker with an isolated source copy.\nContainer images and Node archives are pinned; remaining fidelity gaps are reported.\n`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      file: { type: "string" },
      state: { type: "string" },
      cwd: { type: "string" },
      preset: { type: "string" },
      image: { type: "string" },
      workflow: { type: "string" },
      job: { type: "string" },
      command: { type: "string" },
      node: { type: "string" },
      matrix: { type: "string" },
      expected: { type: "string" },
      ref: { type: "string" },
      env: { type: "string", multiple: true },
      timeout: { type: "string" },
      "latest-failure": { type: "boolean" },
      "working-tree": { type: "boolean" },
    },
  });
  const [command, ...args] = positionals;
  const print = (value: unknown, text?: string) =>
    console.log(
      values.json
        ? JSON.stringify(value)
        : (text ?? JSON.stringify(value, null, 2)),
    );
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (command === "presets") {
    print(
      presets,
      presets
        .map((preset) => `${preset.id}\n  ${preset.description}`)
        .join("\n"),
    );
    return;
  }
  const cwd = resolve(values.cwd ?? process.cwd());
  const root = await execute("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    check: false,
  });
  const state = resolve(
    values.state ??
      join(root.code === 0 ? root.stdout.trim() : cwd, ".plagiarize"),
  );
  if (state.includes(","))
    throw new Error(
      "The state path cannot contain commas because Docker bind mount syntax reserves them.",
    );
  const file = resolve(values.file ?? join(state, "manifest.json"));
  const matrix = values.matrix
    ? z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .parse(JSON.parse(values.matrix))
    : undefined;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  if (command === "init" || command === "capture") {
    if (args[0] === "install") {
      if (
        args[1] !== "github" ||
        !values.workflow ||
        !values.job ||
        !values.ref
      )
        throw new Error(
          "Use capture install github --workflow <path> --job <id> --ref <built-action-sha>.",
        );
      await installGitHubCapture(
        resolve(cwd, values.workflow),
        values.job,
        values.preset ?? "github/ubuntu-24.04",
        values.ref,
        state,
      );
      print(
        { installed: true, workflow: values.workflow, job: values.job },
        "Capture installed. Original workflow saved in .plagiarize/backups.",
      );
      return;
    }
    const options: CaptureOptions = {
      cwd,
      preset: values.preset ?? "github/ubuntu-24.04",
    };
    if (values.workflow) options.workflow = values.workflow;
    if (values.job) options.job = values.job;
    if (values.command) options.command = values.command;
    if (values.node) options.node = values.node;
    if (values.image) options.image = values.image;
    if (matrix) options.matrix = matrix;
    if (values.expected)
      options.expected = z
        .enum(["failure", "success", "unknown"])
        .parse(values.expected);
    const manifest = await capture(options);
    await writeJson(file, manifest);
    print(
      { file, manifest },
      `Captured ${manifest.job.steps.length} shell steps in ${file}. ${manifest.gaps.filter((gap) => gap.blocking).length} blockers.`,
    );
    return;
  }
  if (
    command === "import" ||
    (command === "reproduce" && (args[0] || values["latest-failure"]))
  ) {
    const selection: GitHubSelection = { cwd };
    if (args[0]) selection.url = args[0];
    if (values["latest-failure"]) selection.latestFailure = true;
    if (values.job) selection.job = values.job;
    if (values.preset) selection.preset = values.preset;
    if (values.node) selection.node = values.node;
    if (matrix) selection.matrix = matrix;
    const manifest = await new GitHubProvider().import(selection);
    await writeJson(file, manifest);
    if (command === "import") {
      print(
        { file, manifest },
        `Imported ${manifest.job.name} at ${manifest.source.commit}. Run plagiarize inspect for fidelity gaps.`,
      );
      return;
    }
  }
  if (command === "inspect") {
    const manifest = await readManifest(file);
    print({ manifest, requiredInputs: requiredInputs(manifest) });
    return;
  }
  if (command === "reproduce" || command === "rerun") {
    if (command === "rerun" && !values["working-tree"])
      throw new Error("Use rerun --working-tree to test your local changes.");
    const manifestPath =
      command === "rerun" && !values.file
        ? (await lastResult(state)).manifestPath
        : file;
    const manifest = await readManifest(manifestPath);
    const timeoutMs = values.timeout
      ? z.coerce.number().int().min(1).max(86400).parse(values.timeout) * 1000
      : 1_800_000;
    const result = await new ReplayRunner().replay(manifest, {
      cwd,
      state,
      workingTree: Boolean(values["working-tree"]),
      env: values.env ?? [],
      timeoutMs,
      signal: controller.signal,
    });
    print(
      result,
      `${manifest.job.name}: exit ${result.exitCode}; match: ${result.match}\nLogs: ${result.directory}\nFidelity gaps: ${result.gaps.length}. Run plagiarize inspect for details.`,
    );
    process.exitCode = Math.min(result.exitCode, 255);
    return;
  }
  if (command === "compare") {
    const result = await lastResult(state);
    print({
      ...compareOutcome(await readManifest(result.manifestPath), result.steps),
      exitCode: result.exitCode,
      steps: result.steps,
      gaps: result.gaps,
    });
    return;
  }
  if (command === "shell") {
    if (!process.stdin.isTTY)
      throw new Error(
        "shell needs an interactive terminal. Use reproduce --json for agents.",
      );
    const result = await lastResult(state);
    await execute("docker", ["start", result.container]);
    try {
      process.exitCode = await new Promise<number>((resolveCode, reject) => {
        const child = spawn(
          "docker",
          ["exec", "-it", "--workdir", "/workspace", result.container, "bash"],
          { stdio: "inherit" },
        );
        child.on("error", reject);
        child.on("close", (code) => resolveCode(code ?? 1));
      });
    } finally {
      await execute("docker", ["stop", "--time", "1", result.container], {
        check: false,
      });
    }
    return;
  }
  throw new Error(`Unknown command "${command}". Use --help.`);
}

main().catch((error) => {
  const message = errorMessage(error);
  if (process.argv.includes("--json"))
    console.log(JSON.stringify({ error: { message }, reproduced: null }));
  else console.error(`plagiarize: ${message}`);
  process.exitCode = 2;
});
