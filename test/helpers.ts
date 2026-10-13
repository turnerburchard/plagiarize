import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, type CommandOptions } from "../src/core/process.js";
import { resolve } from "node:path";

export function runCli(args: string[], options?: CommandOptions) {
  return execute(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), resolve("src/cli.ts"), ...args],
    options,
  );
}
import { parseManifest, type Manifest } from "../src/core/manifest.js";

export function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return parseManifest({
    schemaVersion: 1,
    capturedAt: "2026-01-01T00:00:00.000Z",
    provider: "github",
    source: { repository: "acme/app", commit: "a".repeat(40) },
    runner: {
      preset: "github/ubuntu-24.04",
      image: "ubuntu:24.04",
      platform: "linux/amd64",
      observed: {},
    },
    job: {
      id: "test",
      name: "test",
      steps: [{ id: "test", name: "Test", run: "npm test" }],
    },
    expected: { conclusion: "failure", failingStep: "test" },
    gaps: [],
    ...overrides,
  });
}

export async function repository(): Promise<{
  directory: string;
  commit: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "plagiarize-test-"));
  await execute("git", ["init", "--quiet", "--initial-branch=main", directory]);
  await execute(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/app.git"],
    { cwd: directory },
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  );
  await writeFile(
    join(directory, "failure.test.js"),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('runner-specific failure', () => { assert.equal(process.platform, 'linux'); assert.equal(1, 2); });\n",
  );
  await execute("git", ["add", "."], { cwd: directory });
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
      "Fixture",
    ],
    { cwd: directory },
  );
  const commit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: directory })
  ).stdout.trim();
  return {
    directory,
    commit,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
