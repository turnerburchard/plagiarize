import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJob } from "../src/providers/workflow.js";

const context = {
  github: { repository: "acme/app", sha: "a".repeat(40) },
  nodeVersion: "22.19.0",
  matrix: { node: 22 },
};
const workflow =
  "name: CI\non: push\nenv:\n  MODE: test\njobs:\n  test:\n    name: test (${{ matrix.node }})\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - name: Test\n        id: test\n        env:\n          TOKEN: ${{ secrets.PACKAGE_TOKEN }}\n        run: npm test\n";

test("extracts named matrix jobs and external secret references without their values", () => {
  const job = extractJob(workflow, "test", context);
  assert.equal(job.name, "test (22)");
  assert.equal(job.steps.length, 1);
  assert.deepEqual(job.steps[0]!.env, {
    MODE: { value: "test" },
    TOKEN: { external: "PACKAGE_TOKEN" },
  });
  assert.equal(job.gaps.filter((gap) => gap.blocking).length, 0);
});

test("unknown actions, conditions, expressions and command-file state block replay", () => {
  for (const step of [
    "uses: vendor/build@v1",
    "run: echo hi\n        if: success()",
    'run: echo "${{ steps.build.outputs.value }}"',
    'run: echo x >> "$GITHUB_ENV"',
  ]) {
    const job = extractJob(
      `jobs:\n  test:\n    steps:\n      - ${step}\n`,
      "test",
      context,
    );
    assert.ok(job.gaps.some((gap) => gap.blocking));
  }
});

test("services, unresolved matrix and upstream dependencies block replay", () => {
  const job = extractJob(
    "jobs:\n  test:\n    needs: build\n    services: {db: {image: postgres}}\n    strategy: {matrix: {node: [22, 24]}}\n    steps: [{run: npm test}]",
    "test",
    { github: {} },
  );
  assert.deepEqual(
    job.gaps.filter((gap) => gap.blocking).map((gap) => gap.code),
    ["services", "upstream-jobs", "matrix"],
  );
});

test("duplicate YAML keys do not silently change commands", () => {
  assert.throws(
    () => extractJob("jobs: {}\njobs: {}", "test", context),
    /Invalid workflow YAML/,
  );
});
