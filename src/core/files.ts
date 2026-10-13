import { mkdir, readFile, rename, writeFile, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseManifest, type Manifest } from "./manifest.js";

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function readJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 2_000_000)
    throw new Error("Expected a regular JSON file smaller than 2 MB.");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readManifest(path: string): Promise<Manifest> {
  return parseManifest(await readJson(path));
}
