export { gitInspectionPolicy } from "./policy";
export { inspectWorkspaceGit } from "./inspect";
export { gitObservationSchema, gitObservationSubjectSchema, createGitObservation } from "./observation";
export { compareGitObservations, gitIsClean, gitOverlayDescriptor, type GitDrift } from "./comparison";
export { gitSourceObservation, gitDirtyPolicyIssues } from "./source";
export type { GitObservation, GitInspection, GitInspectionHooks, GitIssue, GitIssueCode, GitChange,
  GitEntry, InspectGitOptions } from "./types";
