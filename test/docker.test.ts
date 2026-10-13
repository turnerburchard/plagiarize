import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { capture } from "../src/providers/capture.js";
import { ReplayRunner } from "../src/replay/runner.js";
import { execute } from "../src/core/process.js";
import { repository, runCli } from "./helpers.js";
import { writeJson } from "../src/core/files.js";

test(
  "real Docker replay reproduces a pinned failure, caches its environment, and verifies a local fix",
  {
    skip: process.env.PLAGIARIZE_DOCKER_TEST !== "1",
    timeout: 900_000,
  },
  async () => {
    const repo = await repository();
    const state = resolve(".plagiarize/integration");
    const containers: string[] = [];
    try {
      const manifest = await capture({
        cwd: repo.directory,
        preset: "github/ubuntu-24.04",
        command: "node --version && npm test",
        expected: "failure",
      });
      manifest.expected.failingStep = "command";
      const manifestPath = join(repo.directory, "manifest.json");
      await writeJson(manifestPath, manifest);
      const runner = new ReplayRunner();
      const original = await runner.replay(manifest, {
        cwd: repo.directory,
        state,
      });
      containers.push(original.container);
      assert.equal(original.exitCode, 1);
      assert.equal(original.reproduced, true);
      assert.equal(original.match, "same-step-and-outcome");
      assert.match(
        await readFile(original.steps[0]!.log, "utf8"),
        /runner-specific failure/,
      );
      assert.match(
        await readFile(original.steps[0]!.log, "utf8"),
        new RegExp(`v${manifest.runner.node!.replaceAll(".", "\\.")}`),
      );
      await writeFile(
        join(repo.directory, "failure.test.js"),
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('runner-specific failure', () => { assert.equal(process.platform, 'linux'); assert.equal(1, 1); });\n",
      );
      const fixed = await runner.replay(manifest, {
        cwd: repo.directory,
        state,
        workingTree: true,
      });
      containers.push(fixed.container);
      assert.equal(fixed.image, original.image);
      assert.equal(fixed.exitCode, 0);
      assert.equal(fixed.reproduced, false);
      assert.equal(fixed.match, "different");
      const again = await runner.replay(manifest, {
        cwd: repo.directory,
        state,
      });
      containers.push(again.container);
      assert.equal(again.exitCode, 1);
      assert.equal(again.image, original.image);
      assert.match(
        await readFile(join(repo.directory, "failure.test.js"), "utf8"),
        /assert.equal\(1, 1\)/,
      );
      const reproduced = await runCli(
        [
          "reproduce",
          "--cwd",
          repo.directory,
          "--state",
          state,
          "--file",
          manifestPath,
          "--json",
        ],
        { check: false },
      );
      const reproducedResult = JSON.parse(reproduced.stdout);
      containers.push(reproducedResult.container);
      assert.equal(reproduced.code, 1);
      assert.equal(reproducedResult.reproduced, true);
      const rerun = await runCli([
        "rerun",
        "--working-tree",
        "--cwd",
        repo.directory,
        "--state",
        state,
        "--json",
      ]);
      const rerunResult = JSON.parse(rerun.stdout);
      containers.push(rerunResult.container);
      assert.equal(rerunResult.exitCode, 0);
      assert.equal(rerunResult.match, "different");
      const comparison = await runCli([
        "compare",
        "--cwd",
        repo.directory,
        "--state",
        state,
        "--json",
      ]);
      assert.equal(JSON.parse(comparison.stdout).reproduced, false);
      const timed = structuredClone(manifest);
      timed.job.steps[0]!.run = "sleep 5";
      await assert.rejects(
        runner.replay(timed, { cwd: repo.directory, state, timeoutMs: 100 }),
        /timed out/,
      );
    } finally {
      for (const container of containers)
        await execute("docker", ["rm", "--force", container], { check: false });
      await repo.cleanup();
    }
  },
);
