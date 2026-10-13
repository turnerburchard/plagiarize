import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { execute, type Executor } from "../core/process.js";
import { readJson, writeJson } from "../core/files.js";
import {
  fingerprint,
  imageReference,
  type Manifest,
} from "../core/manifest.js";
import { dockerNetwork, certificateBundle } from "./network.js";

const environmentSchema = z.object({
  schemaVersion: z.literal(1),
  runnerFingerprint: z.string(),
  baseImage: imageReference.refine((value) =>
    /@sha256:[a-f0-9]{64}$/.test(value),
  ),
  image: z.string().regex(/^plagiarize-env:[a-f0-9]{24}$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  nodeArchive: z
    .object({
      url: z
        .string()
        .regex(
          /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/node-v\d+\.\d+\.\d+-linux-(x64|arm64)\.tar\.xz$/,
        ),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export type LockedEnvironment = z.infer<typeof environmentSchema>;

export function dockerfile(
  baseImage: string,
  uid: number,
  gid: number,
  node?: LockedEnvironment["nodeArchive"],
): string {
  // These inputs are validated digests, official Node URLs, and host integer IDs.
  const trust = [
    "COPY --chmod=0644 ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
    // COPY also applies its mode to newly created parents. APT runs as _apt,
    // so those directories must remain traversable before bootstrapping TLS.
    "RUN chmod 0755 /etc/ssl /etc/ssl/certs",
  ].join("\n");
  const installNode = node
    ? `RUN curl --fail --silent --show-error --location '${node.url}' -o /tmp/node.tar.xz && echo '${node.sha256}  /tmp/node.tar.xz' | sha256sum --check - && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz`
    : undefined;
  return [
    `FROM ${baseImage}`,
    "USER root",
    trust,
    `RUN for file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do if [ -f "$file" ]; then sed -i 's|http://|https://|g' "$file"; fi; done && apt-get update --error-on=any && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash ca-certificates curl git sudo tar xz-utils && rm -rf /var/lib/apt/lists/*`,
    trust,
    installNode,
    `RUN (getent group ${gid} || groupadd -g ${gid} runner) && useradd -o -u ${uid} -g ${gid} -m -d /home/runner -s /bin/bash runner && echo '#${uid} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner`,
    "USER runner",
    "ENV HOME=/home/runner CI=true",
    "WORKDIR /workspace",
    'CMD ["sleep", "infinity"]',
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export class DockerEnvironment {
  constructor(private readonly run: Executor = execute) {}
  async prepare(
    manifest: Manifest,
    directory: string,
    signal?: AbortSignal,
  ): Promise<LockedEnvironment> {
    const uid = process.getuid?.() ?? 1000,
      gid = process.getgid?.() ?? 1000;
    const certificates = await certificateBundle();
    const certificateHash = fingerprint(certificates);
    const runnerFingerprint = fingerprint({
      image: manifest.runner.image,
      platform: manifest.runner.platform,
      node: manifest.runner.node,
      uid,
      gid,
      recipeTemplate: dockerfile("BASE", uid, gid, {
        url: "ARCHIVE",
        sha256: "CHECKSUM",
      }),
      certificateHash,
    });
    const path = join(
      directory,
      "environments",
      runnerFingerprint,
      "lock.json",
    );
    let previous: LockedEnvironment | undefined;
    try {
      previous = environmentSchema.parse(await readJson(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous) {
      if (previous.runnerFingerprint !== runnerFingerprint)
        throw new Error("Environment lock fingerprint mismatch.");
      const exists = await this.run(
        "docker",
        ["image", "inspect", previous.imageId],
        { check: false },
      );
      if (exists.code === 0) return previous;
    }
    const commandOptions = signal
      ? { signal, timeoutMs: 900_000 }
      : { timeoutMs: 900_000 };
    let baseImage = previous?.baseImage;
    if (!baseImage) {
      await this.run(
        "docker",
        ["pull", "--platform", manifest.runner.platform, manifest.runner.image],
        commandOptions,
      );
      const inspected = JSON.parse(
        (
          await this.run("docker", [
            "image",
            "inspect",
            manifest.runner.image,
            "--format",
            "{{json .RepoDigests}}",
          ])
        ).stdout,
      ) as unknown;
      const digests = z
        .array(z.string().regex(/@sha256:[a-f0-9]{64}$/))
        .parse(inspected);
      if (!digests[0])
        throw new Error(
          "Container image has no registry digest. Use a published image reference.",
        );
      baseImage = digests[0];
    }
    let nodeArchive = previous?.nodeArchive;
    if (manifest.runner.node && !nodeArchive) {
      const version = manifest.runner.node;
      const architecture =
        manifest.runner.platform === "linux/arm64" ? "arm64" : "x64";
      const filename = `node-v${version}-linux-${architecture}.tar.xz`;
      const sums = (
        await this.run("curl", [
          "--fail",
          "--silent",
          "--show-error",
          `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
        ])
      ).stdout;
      const line = sums
        .split("\n")
        .find((line) => line.trim().split(/\s+/)[1] === filename);
      if (!line || !/^[a-f0-9]{64}\s/.test(line))
        throw new Error(`Official checksum missing for ${filename}.`);
      nodeArchive = {
        url: `https://nodejs.org/dist/v${version}/${filename}`,
        sha256: line.slice(0, 64),
      };
    }
    const recipe = dockerfile(baseImage, uid, gid, nodeArchive);
    const image = `plagiarize-env:${fingerprint({ recipe, platform: manifest.runner.platform, certificateHash }).slice(0, 24)}`;
    const context = await mkdtemp(join(tmpdir(), "plagiarize-build-"));
    const logFile = join(
      directory,
      "environments",
      runnerFingerprint,
      "build.log",
    );
    await mkdir(join(directory, "environments", runnerFingerprint), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await writeFile(join(context, "Dockerfile"), recipe);
      await writeFile(join(context, "ca-certificates.crt"), certificates);
      const network = await dockerNetwork();
      await this.run(
        "docker",
        [
          "build",
          "--platform",
          manifest.runner.platform,
          "--tag",
          image,
          ...network.names.flatMap((name) => ["--build-arg", name]),
          ...network.hosts.flatMap((host) => ["--add-host", host]),
          context,
        ],
        {
          ...commandOptions,
          logFile,
          env: {
            ...process.env,
            BUILDX_CONFIG:
              process.env.BUILDX_CONFIG ?? join(directory, "buildx"),
          },
        },
      );
      const imageId = (
        await this.run("docker", [
          "image",
          "inspect",
          image,
          "--format",
          "{{.Id}}",
        ])
      ).stdout.trim();
      const locked: LockedEnvironment = environmentSchema.parse({
        schemaVersion: 1,
        runnerFingerprint,
        baseImage,
        image,
        imageId,
      });
      if (nodeArchive) locked.nodeArchive = nodeArchive;
      await writeJson(path, locked);
      return locked;
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }
}
