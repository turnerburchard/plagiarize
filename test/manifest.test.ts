import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "./helpers.js";
import {
  parseManifest,
  assertReplayable,
  requiredInputs,
} from "../src/core/manifest.js";
import { compareOutcome } from "../src/replay/runner.js";

test("strict validation rejects unsafe paths, source identities, versions and environment keys", () => {
  const base = manifest();
  for (const workingDirectory of [
    "/etc",
    "../outside",
    "a/../../outside",
    "a\\b",
  ])
    assert.throws(() =>
      parseManifest({
        ...base,
        job: {
          ...base.job,
          steps: [{ ...base.job.steps[0], workingDirectory }],
        },
      }),
    );
  assert.throws(() => parseManifest({ ...base, schemaVersion: 2 }));
  assert.throws(() =>
    parseManifest({
      ...base,
      source: { repository: "../..", commit: base.source.commit },
    }),
  );
  assert.throws(() =>
    parseManifest({
      ...base,
      runner: { ...base.runner, image: "ubuntu:24.04\nRUN evil" },
    }),
  );
  assert.throws(() =>
    parseManifest({
      ...base,
      job: {
        ...base.job,
        steps: [
          {
            ...base.job.steps[0],
            env: JSON.parse('{"__proto__":{"value":"bad"}}'),
          },
        ],
      },
    }),
  );
});

test("blockers and missing commands prevent false readiness", () => {
  assert.throws(
    () =>
      assertReplayable(
        manifest({
          gaps: [
            {
              code: "unknown-action",
              message: "Resolve the action",
              blocking: true,
            },
          ],
        }),
      ),
    /Resolve the action/,
  );
  assert.throws(
    () =>
      assertReplayable(
        manifest({ job: { id: "test", name: "test", steps: [] } }),
      ),
    /No shell steps/,
  );
});

test("external inputs are deduplicated and only names are exposed", () => {
  const base = manifest();
  base.job.steps[0]!.env = {
    TOKEN: { external: "PACKAGE_TOKEN" },
    OTHER: { external: "PACKAGE_TOKEN" },
    MODE: { value: "test" },
  };
  assert.deepEqual(requiredInputs(base), ["PACKAGE_TOKEN"]);
});

test("comparison distinguishes matching failed steps, different failures, fixes and unknown outcomes", () => {
  const step = { id: "test", name: "Test", exitCode: 1, log: "log" };
  assert.deepEqual(compareOutcome(manifest(), [step]), {
    match: "same-step-and-outcome",
    reproduced: true,
  });
  assert.deepEqual(compareOutcome(manifest(), [{ ...step, id: "install" }]), {
    match: "different",
    reproduced: false,
  });
  assert.deepEqual(compareOutcome(manifest(), [{ ...step, exitCode: 0 }]), {
    match: "different",
    reproduced: false,
  });
  assert.deepEqual(
    compareOutcome(manifest({ expected: { conclusion: "unknown" } }), [step]),
    { match: "unknown", reproduced: null },
  );
});
