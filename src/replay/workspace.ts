import { cp, lstat, mkdir, realpath, readlink, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execute, type Executor } from "../core/process.js";
import type { Manifest } from "../core/manifest.js";

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function prepareWorkspace(
  manifest: Manifest,
  destination: string,
  cwd: string,
  workingTree: boolean,
  run: Executor = execute,
): Promise<void> {
  let local: string | undefined;
  const root = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    check: false,
  });
  if (root.code === 0) {
    const candidate = root.stdout.trim();
    const origin = await run("git", ["remote", "get-url", "origin"], {
      cwd: candidate,
      check: false,
    });
    const normalized = origin.stdout
      .trim()
      .replace(/^git@github.com:/, "https://github.com/")
      .replace(/^ssh:\/\/git@github.com\//, "https://github.com/")
      .replace(/\.git$/, "");
    if (normalized === `https://github.com/${manifest.source.repository}`)
      local = candidate;
  }
  if (workingTree && !local)
    throw new Error(
      "--working-tree requires a checkout of the captured repository.",
    );
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await run(
    "git",
    [
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      local ?? `https://github.com/${manifest.source.repository}.git`,
      destination,
    ],
    { timeoutMs: 300_000 },
  );
  await run(
    "git",
    [
      "remote",
      "set-url",
      "origin",
      `https://github.com/${manifest.source.repository}.git`,
    ],
    { cwd: destination },
  );
  const hasCommit = await run(
    "git",
    ["cat-file", "-e", `${manifest.source.commit}^{commit}`],
    { cwd: destination, check: false },
  );
  if (hasCommit.code !== 0)
    await run("git", ["fetch", "--quiet", "origin", manifest.source.commit], {
      cwd: destination,
      timeoutMs: 300_000,
    });
  await run(
    "git",
    ["checkout", "--quiet", "--detach", manifest.source.commit],
    { cwd: destination },
  );
  if (!workingTree || !local) return;
  // Copy Git-visible files only, so ignored dependencies, captures and credentials remain outside the replay.
  const paths = (
    await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: local },
    )
  ).stdout
    .split("\0")
    .filter(Boolean);
  const realRoot = await realpath(local);
  for (const path of paths) {
    const source = resolve(local, path),
      target = resolve(destination, path);
    if (!within(local, source) || !within(destination, target))
      throw new Error("Working tree path escapes the checkout.");
    let stat;
    try {
      stat = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await rm(target, { recursive: true, force: true });
        continue;
      }
      throw error;
    }
    if (!within(realRoot, await realpath(source)))
      throw new Error(
        `Working tree path ${path} resolves outside the checkout.`,
      );
    if (stat.isSymbolicLink()) {
      const link = await readlink(source);
      if (
        isAbsolute(link) ||
        !within(destination, resolve(dirname(target), link))
      )
        throw new Error(`Unsafe working tree symlink ${path}.`);
    }
    // Remove committed parent symlinks before overlaying files from a newer working tree.
    let parent = destination;
    for (const part of relative(destination, dirname(target))
      .split(sep)
      .filter(Boolean)) {
      parent = join(parent, part);
      try {
        if ((await lstat(parent)).isSymbolicLink()) await rm(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(parent, { recursive: true });
    }
    await rm(target, { recursive: true, force: true });
    await cp(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}
