import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  rm,
  symlink,
  mkdir,
  mkdtemp,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWorkspace } from "../src/replay/workspace.js";
import { repository, manifest } from "./helpers.js";
import { execute } from "../src/core/process.js";

test("replay uses the pinned commit; working-tree overlay includes edits, additions and deletions", async () => {
  const repo = await repository(),
    output = await mkdtemp(join(tmpdir(), "plagiarize-workspace-"));
  const capture = manifest({
    source: { repository: "acme/app", commit: repo.commit },
  });
  try {
    await writeFile(join(repo.directory, "failure.test.js"), "local fix");
    await writeFile(join(repo.directory, "added.txt"), "new file");
    await writeFile(join(repo.directory, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo.directory, "ignored.txt"), "do not copy");
    await rm(join(repo.directory, "package.json"));
    await prepareWorkspace(
      capture,
      join(output, "original"),
      repo.directory,
      false,
    );
    assert.match(
      await readFile(join(output, "original", "failure.test.js"), "utf8"),
      /assert.equal\(1, 2\)/,
    );
    await prepareWorkspace(
      capture,
      join(output, "overlay"),
      repo.directory,
      true,
    );
    assert.equal(
      await readFile(join(output, "overlay", "failure.test.js"), "utf8"),
      "local fix",
    );
    assert.equal(
      await readFile(join(output, "overlay", "added.txt"), "utf8"),
      "new file",
    );
    await assert.rejects(readFile(join(output, "overlay", "package.json")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(output, "overlay", "ignored.txt")), {
      code: "ENOENT",
    });
  } finally {
    await repo.cleanup();
    await rm(output, { recursive: true, force: true });
  }
});

test("working-tree symlinks pointing outside the checkout are rejected", async () => {
  const repo = await repository(),
    output = await mkdtemp(join(tmpdir(), "plagiarize-workspace-"));
  try {
    await symlink("/etc/passwd", join(repo.directory, "outside"));
    await assert.rejects(
      prepareWorkspace(
        manifest({ source: { repository: "acme/app", commit: repo.commit } }),
        join(output, "overlay"),
        repo.directory,
        true,
      ),
      /outside the checkout/,
    );
  } finally {
    await repo.cleanup();
    await rm(output, { recursive: true, force: true });
  }
});

test("overlay replaces old directory symlinks without following them on the host", async () => {
  const repo = await repository(),
    output = await mkdtemp(join(tmpdir(), "plagiarize-workspace-"));
  try {
    await symlink("/tmp", join(repo.directory, "directory"));
    await execute("git", ["add", "."], { cwd: repo.directory });
    await execute(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "Link",
      ],
      { cwd: repo.directory },
    );
    const commit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: repo.directory })
    ).stdout.trim();
    await execute("git", ["rm", "--quiet", "directory"], {
      cwd: repo.directory,
    });
    await mkdir(join(repo.directory, "directory"));
    await writeFile(
      join(repo.directory, "directory", "file.txt"),
      "safe overlay",
    );
    await prepareWorkspace(
      manifest({ source: { repository: "acme/app", commit } }),
      join(output, "overlay"),
      repo.directory,
      true,
    );
    assert.equal(
      await readFile(join(output, "overlay", "directory", "file.txt"), "utf8"),
      "safe overlay",
    );
  } finally {
    await repo.cleanup();
    await rm(output, { recursive: true, force: true });
  }
});
