import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { capture } from "../src/providers/capture.js";
import { installGitHubCapture } from "../src/providers/install.js";
import { repository } from "./helpers.js";

test("capture pins Git source and whitelists runner metadata without capturing process secrets", async () => {
  const repo = await repository();
  try {
    const result = await capture(
      {
        cwd: repo.directory,
        preset: "github/ubuntu-24.04",
        command: "npm test",
        expected: "failure",
      },
      {
        SECRET_TOKEN: "must-not-be-recorded",
        ImageOS: "ubuntu24",
        ImageVersion: "20260101.1",
      },
    );
    assert.equal(result.source.commit, repo.commit);
    assert.equal(result.source.repository, "acme/app");
    assert.equal(result.runner.observed.ImageVersion, "20260101.1");
    assert.equal(
      JSON.stringify(result).includes("must-not-be-recorded"),
      false,
    );
    assert.match(result.runner.node!, /^\d+\.\d+\.\d+$/);
  } finally {
    await repo.cleanup();
  }
});

test("install preserves workflow comments, inserts after runtime setup, and prevents duplicates", async () => {
  const repo = await repository();
  try {
    const file = join(repo.directory, "workflow.yml");
    await writeFile(
      file,
      "# Keep this comment\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: npm test\n",
    );
    await installGitHubCapture(
      file,
      "test",
      "github/ubuntu-24.04",
      "b".repeat(40),
      join(repo.directory, ".plagiarize"),
    );
    const text = await readFile(file, "utf8");
    assert.ok(text.includes("# Keep this comment"));
    assert.ok(
      text.indexOf("actions/setup-node") < text.indexOf("plagiarize-capture"),
    );
    assert.ok(text.indexOf("plagiarize-capture") < text.indexOf("npm test"));
    await assert.rejects(
      () =>
        installGitHubCapture(
          file,
          "test",
          "github/ubuntu-24.04",
          "b".repeat(40),
          join(repo.directory, ".plagiarize"),
        ),
      /already installed/,
    );
  } finally {
    await repo.cleanup();
  }
});
