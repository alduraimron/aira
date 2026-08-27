export const DEFAULT_WORKFLOWS = {
  "feature.yaml": `name: feature
description: Safely implement a new feature through discovery, planning, approval, implementation, review, and summary
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
`,
  "bugfix.yaml": `name: bugfix
description: Investigate and fix a concrete defect through a reviewed, approved plan
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
`,
  "investigate.yaml": `name: investigate
description: Investigate a technical question without modifying the repository
inputs:
  task:
    required: true
steps:
  - id: investigate
    uses: agent
    command: investigate
    artifact:
      name: investigation
      filename: investigation.md
`,
} as const;
