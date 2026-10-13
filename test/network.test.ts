import { test } from "node:test";
import assert from "node:assert/strict";
import { rootCertificates } from "node:tls";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateBundle, dockerNetwork } from "../src/replay/network.js";

test("trust bundles include configured public certificates without copying private-key content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plagiarize-ca-"));
  try {
    const file = join(directory, "ca.pem");
    await writeFile(
      file,
      `${rootCertificates[0]}\n-----BEGIN PRIVATE KEY-----\ndo-not-export\n-----END PRIVATE KEY-----`,
    );
    const bundle = await certificateBundle({ SSL_CERT_FILE: file });
    assert.ok(bundle.includes(rootCertificates[0]!));
    assert.ok(!bundle.includes("PRIVATE KEY"));
    assert.ok(!bundle.includes("do-not-export"));
    await assert.rejects(
      certificateBundle({ SSL_CERT_FILE: join(directory, "missing") }),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("proxy transport passes names rather than credentials and rejects invalid configuration", async () => {
  assert.deepEqual(
    await dockerNetwork({
      HTTPS_PROXY: "http://user:password@127.0.0.1:8080",
      NO_PROXY: "localhost",
    }),
    { names: ["HTTPS_PROXY", "NO_PROXY"], hosts: [] },
  );
  await assert.rejects(
    dockerNetwork({ HTTPS_PROXY: "not-a-url" }),
    /Invalid HTTPS_PROXY/,
  );
});
