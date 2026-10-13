import { z } from "zod";
import { createHash } from "node:crypto";

export const variableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(
    (name) => !["__proto__", "constructor", "prototype"].includes(name),
    "Reserved object key",
  );
export const imageReference = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/);
export const relativePath = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !value.includes("\0"),
    "Expected a relative path within the checkout",
  );
const envValue = z.union([
  z.object({ value: z.string().max(8192) }).strict(),
  z.object({ external: variableName }).strict(),
]);
const environmentSchema = z
  .unknown()
  .refine(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((name) => variableName.safeParse(name).success),
    "Invalid environment variable names",
  )
  .pipe(z.record(variableName, envValue));
export const stepSchema = z
  .object({
    id: z.string().regex(/^[\w.-]+$/),
    name: z.string().max(512),
    run: z.string().min(1).max(128_000),
    workingDirectory: relativePath.default("."),
    env: environmentSchema.default({}),
  })
  .strict();
export const gapSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    blocking: z.boolean(),
  })
  .strict();
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.iso.datetime(),
    provider: z.enum(["github", "blacksmith", "aws-codebuild", "local"]),
    source: z
      .object({
        repository: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
          .refine((name) => ![".", ".."].includes(name.split("/")[1]!)),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict(),
    runner: z
      .object({
        preset: z.string(),
        image: imageReference,
        platform: z.enum(["linux/amd64", "linux/arm64"]),
        observed: z.record(z.string(), z.string()).default({}),
        node: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
      })
      .strict(),
    job: z
      .object({
        id: z.string().regex(/^[\w.-]+$/),
        name: z.string(),
        steps: z.array(stepSchema).max(500),
      })
      .strict(),
    expected: z
      .object({
        conclusion: z.enum(["failure", "success", "unknown"]),
        failingStep: z.string().optional(),
      })
      .strict(),
    github: z
      .object({
        runId: z.string().regex(/^\d+$/),
        attempt: z.number().int().positive(),
        jobId: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    gaps: z.array(gapSchema),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Gap = z.infer<typeof gapSchema>;
export type Environment = Step["env"];

export function parseManifest(value: unknown): Manifest {
  return manifestSchema.parse(value);
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requiredInputs(manifest: Manifest): string[] {
  return [
    ...new Set(
      manifest.job.steps.flatMap((step) =>
        Object.values(step.env).flatMap((value) =>
          "external" in value ? [value.external] : [],
        ),
      ),
    ),
  ].sort();
}

export function assertReplayable(manifest: Manifest): void {
  const blockers = manifest.gaps.filter((gap) => gap.blocking);
  if (!manifest.job.steps.length)
    throw new Error(
      "No shell steps were captured. Supply --command or a supported workflow.",
    );
  if (blockers.length)
    throw new Error(
      `Cannot replay this capture:\n${blockers.map((gap) => `- ${gap.message}`).join("\n")}`,
    );
}
