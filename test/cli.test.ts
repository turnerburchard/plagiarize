import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repository, runCli } from "./helpers.js";

test("CLI capture and inspect produce machine-readable output without credentials", async () => {
  const repo = await repository();
  try {
    const state = join(repo.directory, ".plagiarize");
    const captured = await runCli([
      "capture",
      "--cwd",
      repo.directory,
      "--state",
      state,
      "--command",
      "npm test",
      "--json",
    ]);
    const capture = JSON.parse(captured.stdout);
    assert.equal(capture.manifest.source.commit, repo.commit);
    const inspected = await runCli([
      "inspect",
      "--cwd",
      repo.directory,
      "--state",
      state,
      "--json",
    ]);
    assert.equal(
      JSON.parse(inspected.stdout).manifest.job.steps[0].run,
      "npm test",
    );
    assert.deepEqual(JSON.parse(inspected.stdout).requiredInputs, []);
  } finally {
    await repo.cleanup();
  }
});

test("CLI errors use a distinct exit code and valid JSON; presets work outside a repository", async () => {
  const failed = await runCli(["unknown", "--json"], { check: false });
  assert.equal(failed.code, 2);
  assert.match(JSON.parse(failed.stdout).error.message, /Unknown command/);
  const presets = await runCli(["presets", "--json"]);
  assert.ok(
    JSON.parse(presets.stdout).some(
      (preset: { id: string }) => preset.id === "aws/codebuild-standard-7",
    ),
  );
});
