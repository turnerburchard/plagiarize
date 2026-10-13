import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage } from "../src/core/errors.js";

test("transport errors preserve destinations without signed queries or embedded credentials", () => {
  const result = errorMessage(
    new Error(
      'Get "https://user:password@storage.example.com/file.zip?sig=private-token&expires=tomorrow": Forbidden',
    ),
  );
  assert.equal(
    result,
    'Get "https://storage.example.com/file.zip?[redacted]": Forbidden',
  );
  assert.equal(errorMessage("ordinary error"), "ordinary error");
});
