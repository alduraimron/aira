---
name: aira
description: Use Aira's native Pi tools to inspect, start, supervise, approve, revise, resume, and inspect project workflows. Load when a user wants to execute an agreed coding change with Aira, or asks about an active Aira run. Do not load merely for open-ended brainstorming.
---

# Aira

Aira runs project-defined workflows. The host Pi handles discussion and supervision. Aira controls workflow order, retries, shell checks, approval stops, persistence, and worker isolation. Each Aira agent step uses a fresh bounded worker Pi session.

Use native `aira_*` tools when they are available. Do not run raw `aira` shell commands as a substitute.

## Decide whether to use Aira

Keep discussing when requirements, design, scope, or acceptance criteria are still open. Do not start Aira while the user is brainstorming.

A handoff is ready when:

- the change is concrete
- important design choices have been agreed with the human
- constraints and non-goals are known
- the human wants execution, not more exploration

Use this flow:

```text
DISCUSS
  requirements or design open -> keep discussing
  concrete agreed change      -> READY
READY
  human requests execution    -> HANDOFF
HANDOFF
  prepare a brief             -> AIRA RUN
AIRA RUN
  completed           -> inspect and summarize artifacts
  approval required   -> discuss the artifact with the human
  interrupted         -> offer resume
  manual intervention -> explain the boundary without inventing recovery
```

## Inspect before choosing

Call `aira_project` first. Check whether Aira is initialized and read the actual workflow names and descriptions. Choose the workflow whose description fits the agreed work. Never assume that `feature`, `bugfix`, or another default name exists.

If Aira is not initialized, explain what initialization creates. Call `aira_init` only when the human wants it. The tool will ask for authorization.

## Write the execution brief

Before `aira_start`, compress the agreed discussion into a self-contained brief. Do not forward the conversation transcript.

Use the sections that matter:

```text
Goal

Current problem/context

Chosen approach

Constraints

Acceptance criteria

Non-goals
```

Record decisions already made with the human. Keep unresolved points unresolved. Do not invent agreement. Include concrete repository facts, filenames, interfaces, and verification expectations when they were established during discussion.

Pass this brief unchanged as `aira_start.task`. Use a workflow returned by `aira_project`. The tool preflights the run, shows the proposed handoff to the human, and asks for authorization before creating anything.

## Supervise a run

Aira tools stream compact progress. Let Aira's workflow control execution. Do not duplicate its state machine or start another run to recover a current one.

Use `aira_status` to inspect the active run. With no run ID it prefers the run associated with this Pi session and project, then falls back to the project's latest run. Use an explicit run ID when the human refers to another run.

## Handle lifecycle boundaries

### Approval required

Read the approval message and artifact returned by Aira. If the preview is truncated, use `aira_artifact` and request further pages as needed.

Explain the artifact accurately. Discuss concerns with the human. Never auto-approve, even when the plan looks sound.

After the human decides:

- `aira_continue` with `approve` accepts the displayed approval boundary
- `aira_continue` with `revise` submits the exact agreed feedback
- `aira_continue` with `cancel` records cancellation

Each tool call asks the human for authorization again. For revision, state the proposed feedback in the conversation before calling the tool. Do not blend extra model commentary into the feedback.

### Interrupted

Explain which run and step stopped. If status says resume is allowed and the human wants to continue, call `aira_continue` with `resume`. Aira will use its persisted resume rules and a fresh worker session.

Do not treat every run marked `running` as resumable. Follow `allowedActions`.

### Manual intervention

Explain the reason and preserved evidence. A loop that exhausted its attempts is not an approval. Do not offer approve or revise unless Aira explicitly lists those actions. Do not invent loop-repair behavior.

### Completed

Summarize the completion boundary and artifact list. Use `aira_artifact` to inspect the artifact that answers the user's question. Do not claim you read a full artifact when the tool marked its output truncated.

### Failed or cancelled

Report the boundary and any available artifacts. Do not silently restart or create a replacement run.

## Safety rules

- Never call `aira_continue` with `approve` without the human's explicit decision.
- Never bypass Pi project trust or a tool's authorization dialog.
- Never send the host conversation history into an Aira worker.
- Never reuse the host Pi session as a worker session.
- Never use raw `aira` bash commands when native Aira tools are available.
- Never use artifact parameters for arbitrary paths. Select only names, versions, and paths returned by Aira.
- Never mistake a compact preview for complete content when it says it was truncated.
