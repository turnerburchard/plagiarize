import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReplayRunner } from "../src/replay/runner.js";
import { execute, type Executor } from "../src/core/process.js";
import { manifest, repository } from "./helpers.js";

test("Docker transport errors cannot masquerade as a reproduced application failure", async () => {
  const repo = await repository(),
    state = await mkdtemp(join(tmpdir(), "plagiarize-runner-"));
  const calls: string[][] = [];
  const fake: Executor = async (command, args, options) => {
    if (command !== "docker") return execute(command, args, options);
    calls.push(args);
    return {
      code: args[0] === "exec" ? 125 : 0,
      stdout: "",
      stderr: "Docker error",
    };
  };
  const engine = new ReplayRunner(fake, {
    async prepare() {
      return {
        schemaVersion: 1,
        runnerFingerprint: "fixture",
        baseImage: `ubuntu@sha256:${"a".repeat(64)}`,
        image: `plagiarize-env:${"a".repeat(24)}`,
        imageId: `sha256:${"a".repeat(64)}`,
      };
    },
  });
  try {
    await assert.rejects(
      engine.replay(
        manifest({ source: { repository: "acme/app", commit: repo.commit } }),
        { cwd: repo.directory, state },
      ),
      /did not record an exit status/,
    );
    assert.ok(calls.some((args) => args[0] === "stop"));
    assert.ok(calls.some((args) => args[0] === "rm"));
  } finally {
    await repo.cleanup();
    await rm(state, { recursive: true, force: true });
  }
});
