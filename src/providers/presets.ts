import type { Manifest, Gap } from "../core/manifest.js";

export interface Preset {
  id: string;
  provider: Manifest["provider"];
  image: string;
  description: string;
}

export const presets: readonly Preset[] = [
  {
    id: "github/ubuntu-24.04",
    provider: "github",
    image: "ubuntu:24.04",
    description: "Ubuntu 24.04 container baseline for GitHub Linux jobs",
  },
  {
    id: "github/ubuntu-22.04",
    provider: "github",
    image: "ubuntu:22.04",
    description: "Ubuntu 22.04 container baseline for GitHub Linux jobs",
  },
  {
    id: "blacksmith/ubuntu-24.04",
    provider: "blacksmith",
    image: "ubuntu:24.04",
    description:
      "Ubuntu baseline; Blacksmith VM hardware and image are not replicated",
  },
  {
    id: "aws/codebuild-standard-7",
    provider: "aws-codebuild",
    image: "ubuntu:22.04",
    description:
      "Ubuntu 22.04 baseline for CodeBuild standard 7; curated tools, IAM and AWS services are not replicated",
  },
];

export function getPreset(id: string): Preset {
  const preset = presets.find((preset) => preset.id === id);
  if (!preset)
    throw new Error(
      `Unknown preset ${id}. Run "plagiarize presets" for supported options.`,
    );
  return preset;
}

export function baselineGaps(preset: Preset): Gap[] {
  return [
    {
      code: "container-boundary",
      message: `${preset.description}. Host kernel, hardware, networking and VM privileges are not reproduced.`,
      blocking: false,
    },
    {
      code: "uncaptured-state",
      message:
        "Caches, artifacts, external services, event payload and credentials are not captured automatically.",
      blocking: false,
    },
    {
      code: "mutable-provisioning",
      message:
        "Replay pins the container digest and Node archive checksum. OS package repositories and network-dependent job commands remain mutable.",
      blocking: false,
    },
  ];
}

export function presetForLabels(labels: string[]): Preset {
  if (labels.includes("self-hosted"))
    throw new Error(
      "Self-hosted runners require an explicit --preset and captured configuration.",
    );
  if (labels.some((label) => /blacksmith.*ubuntu.*2404/.test(label)))
    return getPreset("blacksmith/ubuntu-24.04");
  if (labels.includes("ubuntu-24.04") || labels.includes("ubuntu-latest"))
    return getPreset("github/ubuntu-24.04");
  if (labels.includes("ubuntu-22.04")) return getPreset("github/ubuntu-22.04");
  throw new Error(
    `Unsupported runner labels: ${labels.join(", ")}. Use a supported Linux preset explicitly.`,
  );
}
