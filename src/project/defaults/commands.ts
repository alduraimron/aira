export const DEFAULT_COMMANDS = {
  "discover.md": `---
description: Inspect the repository and produce grounded discovery
tools:
  - read
  - grep
  - find
  - ls
---
# Repository discovery

Task:

{{ input.task }}

Inspect the actual repository before making claims. Focus on files and code paths relevant to the task rather than dumping the repository. For a defect, trace the observed behavior and gather evidence for the likely root cause. For a feature, identify the existing extension points and patterns that should guide the change.

Do not implement or edit files. Do not speculate about code you have not inspected. Separate verified facts from uncertainty, and call out anything you could not confirm.

The \`discovery\` artifact must be concise and use these sections:

## Goal / task context
## Relevant architecture
## Relevant files
## Existing patterns
## Dependencies / integrations
## Testing / verification setup
## Constraints
## Risks
## Unknowns
`,
  "plan.md": `---
description: Create a concrete implementation plan from repository evidence
tools:
  - read
  - grep
  - find
  - ls
---
# Implementation plan

Task:

{{ input.task }}

Discovery:

{{ artifacts.discovery }}

Create a plan grounded in the task, the discovery artifact, and any focused read-only inspection needed to confirm details.

Do not implement or edit files. Name concrete files, functions, and modules when the evidence supports them. Mark uncertain files or APIs as uncertain instead of inventing them. For a defect, address the root cause with the smallest safe correction. For a feature, use existing extension points where practical. Preserve the existing architecture unless the plan gives a specific reason not to.

The \`plan\` artifact must use these sections:

## Goal
## Current architecture
## Proposed changes
## Files to change
## Implementation steps
## Verification
## Risks
## Out of scope
`,
  "implement.md": `---
description: Implement the approved plan within its stated scope
tools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
  - bash
---
# Implement the approved plan

Task:

{{ input.task }}

Discovery:

{{ artifacts.discovery }}

Approved plan:

{{ artifacts.plan }}

Inspect each relevant file before modifying it. Follow existing repository conventions and implement only the approved scope. Avoid unrelated refactors. Leave the repository in a coherent state.

Do not invent verification policy or treat ad hoc checks as a workflow gate. Deterministic verification belongs in explicit workflow shell steps. If the approved plan requires a narrowly scoped command to support implementation, record what you ran and its result.

The \`implementation\` artifact must summarize the completed work with these sections:

## Implementation
## Changed files
## Design decisions
## Known limitations
## Intentionally omitted
`,
  "repair.md": `---
description: Repair a deterministic verification failure with the smallest safe change
tools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
  - bash
---
# Repair verification failure

Task:

{{ input.task }}

Discovery:

{{ artifacts.discovery }}

Approved plan:

{{ artifacts.plan }}

Verification status: {{ steps.verify.status }}
Verification success: {{ steps.verify.success }}
Verification exit code: {{ steps.verify.exit_code }}

Verification output:

{{ steps.verify.output }}

Inspect the verification output first and identify the root cause. Make the smallest correction needed. Do not redesign unrelated code, and do not hide, weaken, or delete failing tests merely to make the command pass.

Respect the approved plan unless the failure proves that an adjustment is necessary. In the completion summary, state the root cause, changed files, checks run, remaining failures, and any deviation from the plan.
`,
  "review.md": `---
description: Review the implemented change without modifying the repository
tools:
  - read
  - grep
  - find
  - ls
---
# Independent implementation review

Task:

{{ input.task }}

Discovery:

{{ artifacts.discovery }}

Approved plan:

{{ artifacts.plan }}

Implementation summary:

{{ artifacts.implementation }}

Review the actual current repository state. Use the implementation summary to locate changed files, then inspect those files and relevant surrounding code. Do not silently fix issues or edit files.

Focus on correctness, regressions, missing tests, security-relevant mistakes when applicable, and alignment with the approved scope. Classify important findings clearly. Skip style comments unless they materially affect maintainability. Report only verification evidence you can support, and do not imply that checks passed when you have no evidence.

The \`review\` artifact must use these sections:

## Verdict
## Findings
## Correctness
## Scope / plan alignment
## Testing / verification
## Risks
## Recommended follow-ups
`,
  "investigate.md": `---
description: Investigate a technical question without changing repository files
tools:
  - read
  - grep
  - find
  - ls
---
# Technical investigation

Task:

{{ input.task }}

Inspect the repository and answer the task from evidence. Cite relevant file paths, functions, and code paths in prose. Distinguish verified facts from inference and state what remains unknown.

Do not edit or write files. Keep the investigation focused on the question.

The \`investigation\` artifact must use these sections:

## Question / goal
## Evidence
## Relevant architecture / code paths
## Findings
## Likely cause or explanation
## Risks / unknowns
## Recommended next steps
`,
  "summary.md": `---
description: Summarize a completed implementation workflow for the user
tools: []
---
# Workflow summary

Task:

{{ input.task }}

Approved plan:

{{ artifacts.plan }}

Implementation:

{{ artifacts.implementation }}

Review:

{{ artifacts.review }}

Produce a concise final account of what happened. Preserve the review verdict and material findings accurately. Do not claim verification that the supplied artifacts do not establish.

The \`summary\` artifact must use these sections:

## Outcome
## Work completed
## Review result
## Verification
## Remaining risks
## Follow-up
`,
} as const;
