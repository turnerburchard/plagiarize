# Plagiarize

Capture a CI job, replay its failure locally, and verify a fix in the same prepared environment. Built for developers and agents.

```sh
plagiarize reproduce --latest-failure --json
# Edit your checkout, then test the fix:
plagiarize rerun --working-tree --json
```

The first version supports **Linux container replay of Bash and Node jobs**. It reports what it knows and blocks unsupported workflow features. It does not claim to clone a hosted VM exactly.

## Install and develop

Requires Node.js 22+, Git, curl, and a local Docker daemon. GitHub imports also require GitHub CLI (`gh`) with repository and Actions read access. Existing `gh` authentication is reused, including private-repository access where authorized.

```sh
npm ci
npm run check
npm run test:docker       # Real containers; first run installs the replay environment
npm install -g .         # Optional local installation; package is not published yet
```

Without global installation, use `node dist/cli.js` or `npm run dev -- <command>`. `plagiarize --help` lists commands and options. `npm run build` builds the CLI and the self-contained GitHub action bundle.

## Start from a preset

No run URL required. Run from a committed checkout with a GitHub origin:

```sh
plagiarize presets
plagiarize init --preset github/ubuntu-24.04 --command 'npm ci && npm test'
plagiarize inspect
plagiarize reproduce
```

| Preset                     | Container baseline                                 |
| -------------------------- | -------------------------------------------------- |
| `github/ubuntu-24.04`      | Ubuntu 24.04                                       |
| `github/ubuntu-22.04`      | Ubuntu 22.04                                       |
| `blacksmith/ubuntu-24.04`  | Ubuntu 24.04; not the Blacksmith VM                |
| `aws/codebuild-standard-7` | Ubuntu 22.04; not the full curated CodeBuild image |

Capture on Blacksmith or CodeBuild with `plagiarize capture --preset <id> --command '<build commands>'`, then retain `.plagiarize/manifest.json` using that provider's artifact mechanism. Their APIs, VM provisioning, IAM, buildspec parsing, and automatic artifact discovery are not implemented. `capture --image <reference>` selects a published Debian/Ubuntu-compatible custom image. Windows and macOS execution are not supported.

## Capture in GitHub Actions

Place capture **after checkout and runtime setup**, before application commands. It observes the Node version on the job's PATH, reads the workflow, and uploads a manifest immediately, so subsequent test failures still have a capture.

```yaml
steps:
  - uses: actions/checkout@<pinned-sha>
  - uses: actions/setup-node@<pinned-sha>
    with:
      node-version: "22"
  - uses: turnerburchard/plagiarize@<built-action-commit-sha>
    with:
      preset: github/ubuntu-24.04
      matrix: ${{ toJSON(matrix) }}
  - name: Test
    run: npm ci && npm test
```

The action uploads `manifest.json` in a `plagiarize-<run>-<attempt>-<job>` artifact (matrix variants add a hash), and writes a replay command to the job summary. Use explicitly named matrix jobs, such as `name: test (${{ matrix.node }})`, so captures map unambiguously to GitHub's display name. Upload uses existing Actions runtime credentials; no additional secret is required.

This repository's CI builds the action before using it with `uses: ./`. The compiled `action/dist/index.mjs` is committed so other repositories can reference any published commit directly. Run `npm run build` before committing action changes and pin integrations to the full commit SHA. The CLI package is not yet published to npm.

To install the step into an existing workflow, retaining comments and saving a backup:

```sh
plagiarize capture install github \
  --workflow .github/workflows/ci.yml --job test \
  --ref <built-action-commit-sha>
```

For local capture from a workflow:

```sh
plagiarize capture --workflow .github/workflows/ci.yml --job test
```

## Discover and replay a failure

```sh
plagiarize reproduce --latest-failure
plagiarize reproduce https://github.com/org/repo/actions/runs/123 --job test
plagiarize import https://github.com/org/repo/actions/runs/123
plagiarize inspect --json
plagiarize reproduce --file ./downloaded/manifest.json
```

Discovery uses the current repository and branch. A detached checkout needs an explicit URL. Multiple failed jobs require `--job <name-or-numeric-id>`. Imports use the exact run attempt, paginate jobs and artifacts, validate capture identity, and prefer captures. Without capture, the CLI reads the workflow at the run's source commit. Supply `--node x.y.z` and `--matrix '<json>'` when those inputs are missing. Custom checkout refs are rejected if they do not match the selected run.

Each replay checks out the captured SHA into an isolated directory. Changes in your source checkout do not affect `reproduce`. `rerun --working-tree` overlays tracked and nonignored untracked files, including deletions, onto that pinned checkout. It does not overwrite your original files or use Git worktrees.

The base image is locked to a registry digest. An exact Node archive is downloaded over verified HTTPS and checked against its official SHA-256; the prepared image is reused by immutable Docker image ID. Workflow actions are not executed directly: supported checkout and setup-node steps use source/runtime equivalents. Bash steps execute with `-e -o pipefail` in one container, stopping at the first failure.

## Results for agents

`--json` keeps stdout machine-readable. Every run stores an immutable copy of its capture and per-step logs under `.plagiarize/runs`. The latest result is in `.plagiarize/last.json`.

```json
{
  "exitCode": 1,
  "reproduced": true,
  "match": "same-step-and-outcome",
  "workingTree": false
}
```

Actual results also include image ID, log paths, steps, and fidelity gaps. `same-step-and-outcome` means the same captured step failed; it does **not** prove identical error text or root cause. `outcome-only` is weaker evidence. Unknown original outcomes produce `reproduced: null`. `compare` reports this evidence explicitly. Replay returns the job's exit code, including nonzero status for a reproduced failure; CLI/setup errors return 2 with an `error` object in JSON mode. A successful fix reports `exitCode: 0` and no longer matches the original failure.

```sh
plagiarize compare --json
plagiarize shell    # Reopen the stopped container from the latest replay
```

Containers are retained stopped for debugging; remove one with `docker rm <container-from-result>`. Environment locks and images are reused across runs. A per-step timeout defaults to 30 minutes (`--timeout <seconds>`). Cancelled or broken executions stop and remove their container.

## Inputs and fidelity

Capture never dumps process environment variables. It whitelists runner metadata and records workflow-declared values. A declaration like `TOKEN: ${{ secrets.PACKAGE_TOKEN }}` becomes an external input name, with no captured token value:

```sh
# Set PACKAGE_TOKEN securely in your local environment first.
plagiarize reproduce --env PACKAGE_TOKEN
```

Only opted-in variables, declared step environment, basic CI context, and existing network proxy configuration reach the container. Credentials are passed by environment name, not on command lines. Job output can itself contain secrets: treat local logs as sensitive. Captures contain commands and workflow literals; do not hardcode credentials in workflows. Secret expressions inside shell text are blocked; use shell variables and workflow `env` instead.

Supported: Bash `run`, relative working directories, scalar environment values and external inputs, captured simple matrix values, checkout without custom options, and numeric setup-node versions. Capture and artifact-upload transport steps are omitted.

Blockers include unknown actions, reusable workflows, upstream dependencies, services, step conditions, per-step workflow timeouts, continue-on-error, GitHub command-file state, unresolved expressions, and non-Bash shells. VM kernel, hardware, full tool inventory, caches, artifacts, event payload, external services, and network state remain gaps. OS package provisioning and network-dependent commands remain mutable even when the base image and Node are pinned.

Replay executes repository code with network access and passwordless sudo **inside the container**, without the Docker socket or original source directory mounted. A local Docker daemon is required for bind mounts. Docker is an execution boundary, not a guarantee that arbitrary code is harmless.

## Architecture

- `src/core`: versioned manifest, bounded process execution, atomic JSON persistence.
- `src/providers`: presets, workflow interpretation, capture, GitHub discovery, workflow installation.
- `src/replay`: source isolation, image provisioning, proxy transport, execution, outcome comparison.
- `src/cli.ts` and `src/action.ts`: entry points over those shared services.

Runtime dependencies are YAML parsing and schema validation. GitHub artifact tooling is bundled only into the action. Command execution is injected for tests; no host shell interpolation is used. Additional providers can produce the same manifest, and a future VM engine can consume it without changing capture or discovery.
