import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { GitHubProvider, parseRunUrl } from "../src/providers/github.js";
import type { Executor } from "../src/core/process.js";
import { writeJson } from "../src/core/files.js";
import { manifest } from "./helpers.js";

const commit = "a".repeat(40);
const metadata = {
  id: 123,
  run_attempt: 2,
  head_sha: commit,
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  repository: { full_name: "acme/app" },
};
const selected = {
  id: 456,
  name: "test",
  conclusion: "failure",
  labels: ["ubuntu-24.04"],
  steps: [{ name: "Test", conclusion: "failure" }],
};
const workflow =
  "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - name: Test\n        id: test\n        run: npm test\n";

function responses(
  options: {
    artifact?: boolean;
    multiple?: boolean;
    wrongCommit?: boolean;
  } = {},
): { execute: Executor; calls: string[][] } {
  const calls: string[][] = [];
  const execute: Executor = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "run" && args[1] === "download") {
      const directory = args[args.indexOf("--dir") + 1]!;
      await writeJson(
        join(directory, "manifest.json"),
        manifest({
          source: {
            repository: "acme/app",
            commit: options.wrongCommit ? "b".repeat(40) : commit,
          },
          github: { runId: "123", attempt: 2 },
        }),
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    const endpoint = args.at(-1)!;
    let response: unknown;
    if (endpoint.endsWith("/attempts/2/jobs?per_page=100"))
      response = [
        { jobs: [selected] },
        {
          jobs: options.multiple
            ? [{ ...selected, id: 457, name: "other" }]
            : [],
        },
      ];
    else if (endpoint.endsWith("/artifacts?per_page=100"))
      response = [
        {
          artifacts: options.artifact
            ? [
                {
                  name: "plagiarize-123-2-test",
                  expired: false,
                  size_in_bytes: 1000,
                },
              ]
            : [],
        },
      ];
    else if (endpoint.includes("/contents/"))
      response = {
        encoding: "base64",
        content: Buffer.from(workflow).toString("base64"),
      };
    else if (endpoint.endsWith("/actions/runs/123")) response = metadata;
    else
      throw new Error(`Unexpected test command: ${command} ${args.join(" ")}`);
    return { code: 0, stdout: JSON.stringify(response), stderr: "" };
  };
  return { execute, calls };
}

test("run URLs are restricted to GitHub run paths with no credentials or alternate hosts", () => {
  assert.deepEqual(
    parseRunUrl("https://github.com/acme/app/actions/runs/123"),
    { repository: "acme/app", runId: "123" },
  );
  for (const url of [
    "http://github.com/acme/app/actions/runs/123",
    "https://user:password@github.com/acme/app/actions/runs/123",
    "https://evil.com/acme/app/actions/runs/123",
    "https://github.com/acme/app/actions/jobs/123",
  ])
    assert.throws(() => parseRunUrl(url));
});

test("imports exact attempt and paginated jobs, then matches failed shell step", async () => {
  const fake = responses();
  const result = await new GitHubProvider(fake.execute).import({
    cwd: "/tmp",
    url: "https://github.com/acme/app/actions/runs/123",
  });
  assert.equal(result.github!.attempt, 2);
  assert.equal(result.github!.jobId, 456);
  assert.equal(result.expected.failingStep, "test");
  assert.equal(result.source.commit, commit);
  assert.ok(
    fake.calls.some(
      (call) =>
        call.includes("--paginate") &&
        call.at(-1)!.includes("/attempts/2/jobs"),
    ),
  );
  assert.ok(result.gaps.some((gap) => gap.code === "retrospective-import"));
});

test("uses captured artifacts and rejects captures from another commit", async () => {
  const fake = responses({ artifact: true });
  const result = await new GitHubProvider(fake.execute).import({
    cwd: "/tmp",
    url: "https://github.com/acme/app/actions/runs/123",
  });
  assert.equal(result.job.id, "test");
  assert.ok(
    fake.calls.some((call) => call[1] === "run" && call[2] === "download"),
  );
  assert.ok(!fake.calls.some((call) => call.at(-1)!.includes("/contents/")));
  await assert.rejects(
    new GitHubProvider(
      responses({ artifact: true, wrongCommit: true }).execute,
    ).import({
      cwd: "/tmp",
      url: "https://github.com/acme/app/actions/runs/123",
    }),
    /identity does not match/,
  );
});

test("multiple failed jobs require an explicit selection", async () => {
  await assert.rejects(
    new GitHubProvider(responses({ multiple: true }).execute).import({
      cwd: "/tmp",
      url: "https://github.com/acme/app/actions/runs/123",
    }),
    /Choose one job/,
  );
  const result = await new GitHubProvider(
    responses({ multiple: true }).execute,
  ).import({
    cwd: "/tmp",
    url: "https://github.com/acme/app/actions/runs/123",
    job: "456",
  });
  assert.equal(result.github!.jobId, 456);
});
