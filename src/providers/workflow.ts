import { parseDocument } from "yaml";
import type { Environment, Gap, Step } from "../core/manifest.js";
import { stepSchema, variableName, imageReference } from "../core/manifest.js";

type ObjectValue = Record<string, unknown>;
export interface WorkflowContext {
  github: Record<string, string>;
  matrix?: Record<string, string | number | boolean>;
  nodeVersion?: string;
}
export interface WorkflowJob {
  id: string;
  name: string;
  steps: Step[];
  gaps: Gap[];
  image?: string;
}
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};

/** Resolve only expressions whose values are captured. Unknown expressions never silently become empty strings. */
function interpolate(
  value: string,
  context: WorkflowContext,
  env: Environment,
): string {
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
    const [scope, key, ...rest] = expression.trim().split(".");
    if (!key || rest.length)
      throw new Error(`Unsupported expression: ${expression}`);
    if (scope === "github" && context.github[key] !== undefined)
      return context.github[key]!;
    if (scope === "matrix" && context.matrix?.[key] !== undefined)
      return String(context.matrix[key]);
    if (scope === "env" && env[key] && "value" in env[key])
      return env[key].value;
    if (scope === "runner" && key === "temp") return "/tmp";
    throw new Error(
      `Expression "${expression}" was not captured. Use shell environment variables for runtime secrets.`,
    );
  });
}

function environment(
  value: unknown,
  context: WorkflowContext,
  inherited: Environment,
): Environment {
  const result: Environment = { ...inherited };
  for (const [name, raw] of Object.entries(object(value))) {
    variableName.parse(name);
    if (raw !== null && typeof raw === "object")
      throw new Error(`Environment variable ${name} must be a scalar.`);
    const text = String(raw ?? "");
    const external = text.match(
      /^\$\{\{\s*(?:secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/,
    );
    result[name] = external
      ? { external: external[1]! }
      : { value: interpolate(text, context, result) };
  }
  return result;
}

export function workflowJobIds(yaml: string): string[] {
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid workflow YAML: ${document.errors[0]!.message}`);
  return Object.keys(object(object(document.toJS({ maxAliasCount: 20 })).jobs));
}

export function extractJob(
  yaml: string,
  jobId: string,
  context: WorkflowContext,
): WorkflowJob {
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid workflow YAML: ${document.errors[0]!.message}`);
  const workflow = object(document.toJS({ maxAliasCount: 20 }));
  const jobs = object(workflow.jobs);
  if (!jobs[jobId])
    throw new Error(
      `Workflow has no job "${jobId}". Available jobs: ${Object.keys(jobs).join(", ")}`,
    );
  const job = object(jobs[jobId]);
  const steps: Step[] = [],
    gaps: Gap[] = [];
  const block = (code: string, message: string) =>
    gaps.push({ code, message, blocking: true });
  if (job.services)
    block(
      "services",
      "Service containers are not supported yet; capture their configuration before replay.",
    );
  if (job.needs)
    block(
      "upstream-jobs",
      "This job depends on upstream jobs whose outputs and artifacts are not captured.",
    );
  if (job.uses)
    block(
      "reusable-workflow",
      "Reusable workflow jobs must be resolved before replay.",
    );
  if (job.if)
    gaps.push({
      code: "job-condition",
      message:
        "Job-level conditions are not reevaluated; replay executes the selected job.",
      blocking: false,
    });
  if (
    Object.keys(object(object(job.strategy).matrix)).length &&
    !context.matrix
  )
    block(
      "matrix",
      "Matrix values were not captured. Supply --matrix with the original resolved values.",
    );
  const defaults = { ...object(workflow.defaults), ...object(job.defaults) };
  const runDefaults = {
    ...object(object(workflow.defaults).run),
    ...object(defaults.run),
  };
  let inherited: Environment = {};
  try {
    inherited = environment(
      job.env,
      context,
      environment(workflow.env, context, {}),
    );
  } catch (error) {
    block("environment", String((error as Error).message));
  }
  let image: string | undefined;
  if (job.container) {
    const container =
      typeof job.container === "string"
        ? { image: job.container }
        : object(job.container);
    try {
      image = imageReference.parse(
        interpolate(String(container.image ?? ""), context, inherited),
      );
    } catch (error) {
      block("container", (error as Error).message);
    }
    if (Object.keys(container).some((key) => key !== "image"))
      block(
        "container-options",
        "Container credentials, volumes, environment and options are not supported yet.",
      );
  }
  if (!Array.isArray(job.steps))
    block("steps", "Workflow job has no step list.");
  for (const [index, value] of (Array.isArray(job.steps)
    ? job.steps
    : []
  ).entries()) {
    const raw = object(value),
      id = String(raw.id ?? `step-${index + 1}`);
    const name = String(
      raw.name ??
        (raw.run ? `Run ${String(raw.run).split("\n")[0]}` : (raw.uses ?? id)),
    ).split("\n")[0]!;
    try {
      const uses = typeof raw.uses === "string" ? raw.uses : undefined;
      // Capture and artifact-upload steps only transport metadata; they are never application steps.
      if (
        uses &&
        (uses.startsWith("turnerburchard/plagiarize@") ||
          (uses === "./" &&
            context.github.repository === "turnerburchard/plagiarize") ||
          uses.startsWith("actions/upload-artifact@"))
      ) {
        if (uses.startsWith("actions/upload-artifact@"))
          gaps.push({
            code: "artifact-upload-skipped",
            message: `Artifact upload "${name}" is omitted from local execution.`,
            blocking: false,
          });
        continue;
      }
      if (raw.if)
        throw new Error(
          `Step "${name}" has a condition that is not supported yet.`,
        );
      if (raw["continue-on-error"])
        throw new Error(
          `Step "${name}" uses continue-on-error, which changes failure semantics.`,
        );
      if (raw["timeout-minutes"])
        throw new Error(
          `Step "${name}" has a per-step timeout that is not captured yet.`,
        );
      if (uses) {
        const options = object(raw.with);
        if (uses.startsWith("actions/checkout@")) {
          if (Object.keys(options).length)
            throw new Error(
              "Checkout options require explicit source configuration and are not supported yet.",
            );
        } else if (uses.startsWith("actions/setup-node@")) {
          if (
            Object.keys(options).some(
              (key) =>
                ![
                  "node-version",
                  "cache",
                  "cache-dependency-path",
                  "check-latest",
                ].includes(key),
            )
          )
            throw new Error(
              "setup-node authentication and custom configuration are not supported yet.",
            );
          const version = interpolate(
            String(options["node-version"] ?? ""),
            context,
            inherited,
          );
          if (!context.nodeVersion)
            block(
              "node-version",
              "Exact Node version was not captured. Supply --node with the version from the original job.",
            );
          else if (
            !/^\d+(?:\.\d+(?:\.\d+)?)?$/.test(version) ||
            !`${context.nodeVersion}.`.startsWith(`${version}.`)
          )
            block(
              "node-version",
              `Captured Node ${context.nodeVersion} does not satisfy setup-node version "${version}".`,
            );
          if (options.cache)
            gaps.push({
              code: "cache-skipped",
              message: "setup-node dependency caches are not restored.",
              blocking: false,
            });
        } else
          throw new Error(
            `Action "${uses}" is not supported. Capture its shell equivalent explicitly.`,
          );
        if (!/@[a-f0-9]{40}$/.test(uses))
          gaps.push({
            code: "mutable-action",
            message: `Original action ${uses} uses a mutable revision. Replay uses its supported source/runtime equivalent.`,
            blocking: false,
          });
        continue;
      }
      if (typeof raw.run !== "string")
        throw new Error(
          `Step "${name}" has neither a supported action nor shell commands.`,
        );
      const shell = String(raw.shell ?? runDefaults.shell ?? "bash");
      if (
        !["bash", "bash --noprofile --norc -e -o pipefail {0}"].includes(shell)
      )
        throw new Error(
          `Shell "${shell}" is unsupported; only Bash is currently replayed.`,
        );
      const env = environment(raw.env, context, inherited);
      const run = interpolate(raw.run, context, env);
      if (/\b(?:GITHUB_OUTPUT|GITHUB_ENV|GITHUB_PATH|GITHUB_STATE)\b/.test(run))
        throw new Error(
          `Step "${name}" modifies GitHub command files; cross-step state is not supported yet.`,
        );
      steps.push(
        stepSchema.parse({
          id,
          name: interpolate(name, context, env),
          run,
          env,
          workingDirectory: interpolate(
            String(
              raw["working-directory"] ??
                runDefaults["working-directory"] ??
                ".",
            ),
            context,
            env,
          ),
        }),
      );
    } catch (error) {
      block("unsupported-step", (error as Error).message);
    }
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length)
    block("duplicate-step-id", "Shell step IDs must be unique.");
  let jobName = String(job.name ?? jobId);
  try {
    jobName = interpolate(jobName, context, inherited);
  } catch (error) {
    block("job-name", (error as Error).message);
  }
  const result: WorkflowJob = { id: jobId, name: jobName, steps, gaps };
  if (image) result.image = image;
  return result;
}
