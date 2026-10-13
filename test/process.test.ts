import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/core/process.js";

test("process runner preserves failure status and does not evaluate shell characters", async () => {
  const argument = "$(echo unexpected); echo wrong";
  const result = await execute(
    process.execPath,
    ["-e", "console.log(process.argv[1]); process.exit(7)", argument],
    { check: false },
  );
  assert.equal(result.code, 7);
  assert.equal(result.stdout.trim(), argument);
});

test("timeouts and missing executables are setup errors, not successful replays", async () => {
  await assert.rejects(
    execute(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 20,
    }),
    /timed out/,
  );
  await assert.rejects(execute("plagiarize-no-such-command", []), /ENOENT/);
});
