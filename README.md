# Aira

Aira is a CLI-first workflow orchestrator for coding agents. A workflow defines the order of agent work, shell checks, approvals, loops, and artifacts. Pi handles each agent step in a fresh session.

## Why it exists

Long coding tasks lose context across discovery, planning, implementation, and review. They also tend to mix model judgment with deterministic checks. Aira keeps those concerns separate and persists the useful output of each step so a run can stop at an approval, survive an interruption, and continue from recorded state.

Aira follows five rules:

- Workflow controls process.
- Pi controls reasoning.
- Shell controls deterministic verification.
- Human controls important decisions.
- Artifacts preserve knowledge.

## V1 scope

V1 supports project-local YAML workflows, reusable Markdown commands, strict templates and conditions, sequential execution, bounded loops, shell steps, approvals, persisted runs, versioned artifacts, Pi agent sessions, technical retries, interruption, resume, and CLI status output.

It is intended for local use in one repository. It does not run a server or coordinate parallel workers.

## Install and develop

Aira requires Bun. In this repository:

```bash
bun install
bun test
bun run typecheck
bun run src/cli/main.ts --help
```

The package exposes the `aira` binary at `src/cli/main.ts`. When the package is installed or linked, use `aira` in the examples below. During development, replace `aira` with `bun run src/cli/main.ts`.

Actual agent steps require Pi to have a usable configured model. The generated Aira config does not select a model vendor.

## Quick start

Run these commands at the repository root:

```bash
aira init
aira list
aira run feature "Implement JWT authentication" --dry-run
aira run feature "Implement JWT authentication"
```

The feature workflow pauses after planning. Enter `approve`, `revise`, or `cancel` at the prompt. Choosing `revise` asks for a non-empty revision instruction before the run continues. A second `aira init` reports that Aira is already initialized and leaves every existing file unchanged.

Use `--allow-dirty` when you intentionally want to start a run in a dirty Git worktree:

```bash
aira run bugfix "Fix expired sessions being accepted" --allow-dirty
```

## Project layout

`aira init` creates ordinary project files:

```text
.aira/
├── config.yaml
├── workflows/
│   ├── feature.yaml
│   ├── bugfix.yaml
│   └── investigate.yaml
├── commands/
│   ├── discover.md
│   ├── plan.md
│   ├── implement.md
│   ├── repair.md
│   ├── review.md
│   ├── investigate.md
│   └── summary.md
└── runs/
```

Edit the config, workflows, and commands to fit the repository. Aira loads the defaults through the same public loaders used for user-authored files. There is no hidden built-in workflow behavior.

## CLI commands

```text
aira init
aira list
aira run <workflow> "<task>"
aira run <workflow> "<task>" --dry-run
aira run <workflow> "<task>" --allow-dirty
aira status [run-id]
aira resume <run-id>
```

`--dry-run` validates the config, workflow, command references, and resolved agent settings. It prints the step plan without checking Git, creating a run, starting Pi, or executing shell commands.

Without `--allow-dirty`, `aira run` refuses to start in a dirty Git repository. Non-Git directories are allowed.

## Default workflows

### Feature

`feature` runs discovery, planning, plan approval, implementation, read-only review, and final summary. It writes:

```text
discovery.md
plan-v1.md
implementation-summary.md
review.md
summary.md
```

Revising the plan asks for human feedback, writes `plan-v2.md`, then returns to the same approval. Another revision uses `plan-v2.md` as its previous plan and writes `plan-v3.md`.

### Approval revisions

An approval with `revise: plan` records the feedback, target step, approval step, request time, and exact previous artifact path in `run.json`. Aira then resets the replay range and reruns `plan`. The original `input.task` is never changed.

The target agent receives an `[Aira revision context]` prompt section with the human feedback and previous artifact content. Aira also exposes the same data to strict templates through:

```text
revision.active
revision.feedback
revision.previous_artifact
revision.previous_artifact_name
revision.previous_artifact_path
```

These fields are false or empty outside the intended target execution. After the target succeeds, Aira marks the persisted revision record as resolved. Technical retries and resume keep a pending record active. Later steps do not receive the revision prompt section.

### Bugfix

`bugfix` uses the same process, but the task should describe a concrete defect and expected behavior. Shared prompts tell the agent to find the root cause and keep the approved change small.

### Investigate

`investigate` runs one evidence-based investigation step and writes `investigation.md`. Its command allows only `read`, `grep`, `find`, and `ls`. It has no implementation or shell step.

### Verification in the defaults

The generated config has `commands: {}` because Aira cannot know whether a repository uses Bun, npm, Cargo, Make, or another tool. The feature and bugfix defaults therefore do not include a shell verification step. They are structurally executable in any repository and do not fail because of a guessed package-manager command.

Verification remains explicit in V1. Add project commands to `config.yaml`, then add shell steps or a verify and repair loop to a workflow. Aira does not auto-detect commands.

## Configuration

The generated config is provider-neutral and portable:

```yaml
models: {}

defaults:
  agent_timeout: 900
  shell_timeout: 300
  technical_retries: 1

commands: {}
```

A project can opt into model and shell command aliases:

```yaml
models:
  coding: provider/model-id

defaults:
  model: coding
  agent_timeout: 900
  shell_timeout: 300
  technical_retries: 1

commands:
  test: "bun test"
```

Model aliases map workflow-facing names to Pi model selectors. If no model alias is selected, Aira leaves model choice to Pi.

## Custom workflow example

This workflow adds explicit verification and uses the shipped `repair` command. It requires `commands.test` in `config.yaml`.

```yaml
name: checked-feature
inputs:
  task:
    required: true
steps:
  - id: discover
    uses: agent
    command: discover
    artifact:
      name: discovery
      filename: discovery.md

  - id: plan
    uses: agent
    command: plan
    artifact:
      name: plan
      filename: plan.md
      versioned: true

  - id: approve-plan
    uses: approval
    artifact: plan
    message: Approve this implementation plan?
    revise: plan

  - id: implement
    uses: agent
    command: implement
    artifact:
      name: implementation
      filename: implementation-summary.md

  - id: verify-cycle
    uses: loop
    max_attempts: 3
    until: "steps.verify.success == true"
    steps:
      - id: verify
        uses: shell
        run: "{{ config.commands.test }}"
      - id: repair
        uses: agent
        command: repair
        when: "steps.verify.success == false"

  - id: review
    uses: agent
    command: review
    artifact:
      name: review
      filename: review.md

  - id: summary
    uses: agent
    command: summary
    artifact:
      name: summary
      filename: summary.md
```

Templates are strict. A missing reference is an error. There is no fallback, optional chaining, or conditional syntax inside `{{ ... }}`.

## Command Markdown example

Commands are Markdown prompts with optional YAML frontmatter:

```markdown
---
description: Inspect authentication boundaries
tools:
  - read
  - grep
  - find
  - ls
---
# Authentication review

Task:

{{ input.task }}

Inspect the relevant code before making claims. Return an evidence-based report and do not edit files.
```

Supported metadata is limited to `description`, `model`, `thinking`, `timeout`, `retry`, and `tools`. Aira adds its private completion tool at execution time. Prompts should describe the artifact content, not write files under `.aira/runs/` and not use `DONE` or final-message JSON as a completion signal.

## Runs and artifacts

Each run has its own directory:

```text
.aira/runs/<run-id>/
├── run.json
├── artifacts/
│   ├── discovery.md
│   ├── plan-v1.md
│   └── ...
├── sessions/
│   └── <step-id>-<attempt>.jsonl
└── logs/
```

`run.json` is the source of truth for status, step attempts, current position, relative artifact paths, and revision history. Revision records retain human feedback and the previous artifact reference after they are resolved. Agent artifacts live under `artifacts/`. Versioned artifacts keep ordered paths in run state, and the latest version becomes the current artifact. Session JSONL files record Aira-owned Pi audit events for each attempt.

## Interruption and resume

A controlled interrupt marks active agent or shell work as `interrupted` and persists the run. Resume it with:

```bash
aira resume <run-id>
```

Aira keeps completed steps, resets the interrupted execution point, and starts a fresh Pi session for a rerun. Interrupting an approval leaves the run waiting; `aira resume` opens the approval again.

Interrupted and supported waiting runs can resume. Aira also resumes a running revision checkpoint when `run.json` has a pending revision and its target is pending or running. This covers a process exit after feedback was saved and a crash while the revision target was active. Other runs left `running` still require manual recovery. A loop that exhausts all attempts also waits, but manual loop intervention is not supported.

## V1 limitations

- Execution is sequential. There is no DAG or parallel execution.
- Default feature and bugfix workflows do not run deterministic verification until the project configures it.
- There is no package-manager or verification-command auto-detection.
- Conditions support the documented strict expression language, not arbitrary JavaScript.
- Loops are bounded. Nested loops and approvals inside loops are unsupported.
- Aira does not create commits, branches, pull requests, or worktrees.
- There is no server, HTTP API, database, scheduler, queue, remote runner, plugin system, or workflow marketplace.
- Aira has no global config, provider registry, model capability matrix, or token and cost accounting.
- `aira init` does not migrate or update an existing `.aira/` directory.
