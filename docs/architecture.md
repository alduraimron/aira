# Aira V1 architecture

This document records the V1 boundaries. New work should fit these boundaries unless a later phase changes them deliberately.

## Core principle

```text
Workflow controls process
Pi controls reasoning
Shell controls deterministic verification
Human controls important decisions
Artifacts preserve knowledge
```

Aira coordinates these parts. It does not move agent judgment into the workflow engine or hide deterministic policy inside prompts.

## Main modules

- `workflow` loads YAML, validates the public schema, checks IDs, artifacts, loops, and approval references, and builds the workflow catalog.
- `config` loads project-local aliases and execution defaults from `.aira/config.yaml`.
- `commands` parses reusable Markdown prompts and their supported YAML frontmatter.
- `context`, `template`, and `conditions` resolve strict references against input, config, artifacts, step state, and run identity.
- `run` creates, validates, saves, loads, and lists persisted run state.
- `artifacts` writes agent output under a run and tracks current and versioned relative paths.
- `shell` runs explicit commands with captured output, timeout, and abort support.
- `executor` runs validated steps sequentially and persists state at execution boundaries.
- `approval` applies explicit approve, revise, or cancel decisions to a waiting run.
- `agent` defines the provider-neutral runtime contract. `agent/pi` implements it with Pi.
- `cli` parses commands, checks Git state, drives approvals and resume, and formats lifecycle output.
- `project` discovers `.aira/` and creates the non-destructive V1 default project.

Defaults are ordinary config, workflow, and command files. The runtime gives them no privileged behavior.

## Agent session model

Every agent attempt gets one fresh Pi session. Retries, plan revisions, and interrupted-step reruns create another fresh session. The Aira executor passes the resolved prompt, model selection if present, tool allowlist, timeout, abort signal, audit-log path, and completion contract through `AgentRuntime`.

Aira requires a valid `complete_step` call for semantic completion. Final assistant text alone cannot complete an agent step.

## Run persistence

`.aira/runs/<run-id>/run.json` is the source of truth. It records workflow identity, input, run status, current step, timestamps, per-step attempts and results, and artifact state.

The executor saves transitions before and after external work where needed. State uses schema version `1`. Aira has no migration layer in V1.

## Artifact persistence

Agent steps return artifact content through the completion contract. Aira writes that content under the run's `artifacts/` directory and stores paths relative to the run directory.

A non-versioned artifact keeps one stable path. A versioned artifact appends `-v1`, `-v2`, and later numbers before the file extension. Run state stores the ordered version history and marks the latest path as current.

Prompts never own artifact filesystem paths.

## Execution model

Execution is sequential. The executor visits top-level steps in declaration order. A loop also runs its child steps in declaration order for each bounded attempt.

Supported step kinds are:

- agent
- shell
- approval
- loop

Conditions and templates use strict direct references. Missing values are errors. The language has no template fallback, optional chaining, inline conditional syntax, or arbitrary JavaScript.

## Failure categories

### Domain failure

The requested work ran and produced a negative result. A shell command with a nonzero exit is the common case. Inside a loop, that result remains evidence so a later repair step and the loop condition can react. A top-level shell domain failure stops the run as failed.

### Technical failure

Aira could not execute or validate the step as requested. Examples include provider errors, timeouts, malformed completion, missing templates, unavailable command files, and persistence failures. Technical retries follow explicit step, command, or config precedence. Deterministic setup and completion errors do not become unlimited retries.

### Interrupted

An external abort stopped active work. Aira records the step and run as interrupted instead of treating the event as a timeout or domain failure.

## Approval

An approval step changes the run to `waiting` and persists that boundary. The CLI displays the referenced artifact and requires an explicit decision.

- Approve completes the approval and continues.
- Revise resets the configured earlier agent step through the approval, preserving attempt counts and artifact history.
- Cancel ends the run as cancelled.

The default feature and bugfix workflows approve the versioned plan.

## Loop

A loop has a positive `max_attempts`, a strict `until` condition, and sequential child steps. Child state resets between attempts while attempt counters remain. Nested loops and approval steps inside loops are not supported.

If the condition is still false after the last attempt, the run waits with the final evidence preserved. V1 has no manual loop-intervention decision.

## Resume

Execution resume applies only to a persisted interrupted run. Completed and skipped steps remain complete. Aira resets the interrupted execution point and reruns it. An agent rerun always uses a fresh Pi session.

The CLI also accepts a supported waiting approval and reopens the decision before continuing. It does not recover a run left as `running` by an uncontrolled process crash. Completed, failed, and cancelled runs cannot resume.

## V1 non-goals

V1 does not include:

- DAG or parallel execution
- nested loops
- a server, web UI, or HTTP API
- a database, scheduler, queue, worker fleet, or remote execution
- containers or a sandbox
- worktrees, automatic commits, pull requests, or branch management
- global config, provider registry, or model capability matrix
- arbitrary JavaScript conditions
- package-manager auto-detection
- token or cost accounting
- a plugin system, workflow marketplace, or migration framework
