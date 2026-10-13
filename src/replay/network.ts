import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";

export async function certificateBundle(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const certificates = new Set<string>();
  const files = [
    env.SSL_CERT_FILE ?? "/etc/ssl/certs/ca-certificates.crt",
    env.NODE_EXTRA_CA_CERTS,
  ].filter((file): file is string => Boolean(file));
  for (const file of files) {
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        file !== env.SSL_CERT_FILE &&
        file !== env.NODE_EXTRA_CA_CERTS
      )
        continue;
      throw error;
    }
    const matches = contents.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (!matches)
      throw new Error("A configured CA file contains no PEM certificates.");
    // Copy public trust anchors only, never unrelated content or private-key blocks.
    matches.forEach((certificate) => certificates.add(certificate));
  }
  // Prefer the configured system trust store. Mozilla roots are a portable fallback
  // when the host has no PEM store (for example, macOS with Docker Desktop).
  if (!certificates.size)
    rootCertificates.forEach((certificate) =>
      certificates.add(certificate.trim()),
    );
  return [...certificates].join("\n") + "\n";
}

const proxyNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** Preserve the caller's proxy route, including DNS aliases that Docker's bridge cannot resolve. */
export async function dockerNetwork(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ names: string[]; hosts: string[] }> {
  const names = proxyNames.filter((name) => env[name]);
  const hosts = new Set<string>();
  for (const name of names.filter((name) => !/no_proxy/i.test(name))) {
    let hostname: string;
    try {
      hostname = new URL(env[name]!).hostname;
    } catch {
      throw new Error(`Invalid ${name} proxy configuration.`);
    }
    if (!isIP(hostname)) {
      const addresses = await lookup(hostname, { all: true });
      const address =
        addresses.find((address) => address.family === 4) ?? addresses[0];
      if (!address)
        throw new Error(`Cannot resolve the configured ${name} proxy host.`);
      hosts.add(`${hostname}:${address.address}`);
    }
  }
  return { names, hosts: [...hosts] };
}
