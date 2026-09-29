import { spawn } from "node:child_process";
import { gitInspectionPolicy } from "./policy";
import type { GitIssueCode } from "./types";

export class GitInspectionError extends Error {
  constructor(readonly code: GitIssueCode, readonly detail?: string, readonly path?: string) { super(`${code}${detail ? `: ${detail}` : ""}`); }
}
/** Narrow binary-safe runner. Only the inspector supplies argv; no shell, inherited Git env or stdin. */
export type GitReader = (args: readonly string[], cwd: string) => Promise<Buffer>;
const options = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
  "-c", "core.splitIndex=false", "-c", "color.ui=false", "-c", "core.quotePath=false",
  "-c", "diff.external=", "-c", "diff.trustExitCode=false", "-c", "core.pager=cat"];
export const gitReadOnlyEnvironment = (root: string): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "/bin/false",
  GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_LFS_SKIP_SMUDGE: "1",
  GIT_CEILING_DIRECTORIES: root,
});
export const runReadOnlyGit: GitReader = (args, cwd) => new Promise((resolve, reject) => {
  // This is not a generic process API: only nonmutating Git subcommands are permitted.
  if (!new Set(["rev-parse", "symbolic-ref", "cat-file", "status", "ls-files", "diff-index", "config"])
    .has(args[0] ?? "")) { reject(new GitInspectionError("workspace-git-command-failed", "disallowed-subcommand")); return; }
  const limit = gitInspectionPolicy.bounds;
  const child = spawn("/usr/bin/git", [...options, ...args], { cwd, env: gitReadOnlyEnvironment(cwd),
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout: Buffer[] = [], stderr: Buffer[] = [], out = 0, err = 0, done = false;
  const finish = (error?: GitInspectionError, value?: Buffer) => {
    if (done) return; done = true; clearTimeout(timer);
    if (error) reject(error); else resolve(value!);
  };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new GitInspectionError("workspace-git-timeout")); }, limit.timeout_ms);
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.length;
    if (out > limit.stdout_bytes) { child.kill("SIGKILL"); finish(new GitInspectionError("workspace-git-output-limit", "stdout")); }
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.length;
    if (err > limit.stderr_bytes) { child.kill("SIGKILL"); finish(new GitInspectionError("workspace-git-output-limit", "stderr")); }
    else stderr.push(chunk);
  });
  child.once("error", (error) => finish(new GitInspectionError("workspace-git-command-failed", error.message)));
  child.once("close", (code) => finish(code === 0 ? undefined : new GitInspectionError("workspace-git-command-failed",
    `git ${args[0] ?? "?"} exited ${code}; ${Buffer.concat(stderr).toString("utf8").slice(0, 256)}`), Buffer.concat(stdout)));
});
