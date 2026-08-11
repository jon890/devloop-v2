import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function isSafeRunKey(runKey) {
  return (
    typeof runKey === "string" &&
    runKey.length > 0 &&
    !runKey.includes("\0") &&
    !path.isAbsolute(runKey) &&
    !runKey.includes("/") &&
    !runKey.includes("\\") &&
    runKey !== "." &&
    runKey !== ".." &&
    path.basename(runKey) === runKey
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function pipeGitArchive(repositoryPath, revision, destinationPath) {
  await mkdir(destinationPath, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", repositoryPath, "archive", "--format=tar", revision], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-xf", "-", "-C", destinationPath], { stdio: ["pipe", "ignore", "pipe"] });
    let archiveStderr = "";
    let tarStderr = "";
    archive.stderr.on("data", (chunk) => {
      archiveStderr += chunk;
    });
    tar.stderr.on("data", (chunk) => {
      tarStderr += chunk;
    });
    archive.stdout.pipe(tar.stdin);
    archive.on("error", reject);
    tar.on("error", reject);
    archive.on("exit", (code) => {
      if (code !== 0) {
        tar.kill();
        reject(new Error(`git archive failed with ${code}: ${archiveStderr.trim()}`));
      }
    });
    tar.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extract failed with ${code}: ${tarStderr.trim()}`));
      }
    });
  });
}

async function materializeMemoryWorkspace({ source, runKey, runsRoot = "eval/runs/workspaces" }) {
  if (!isSafeRunKey(runKey)) {
    throw new Error("runKey must be a non-empty safe identifier");
  }
  const canonicalRunsRoot = path.resolve(runsRoot);
  const workspacePath = path.resolve(canonicalRunsRoot, runKey);
  const relativeWorkspace = path.relative(canonicalRunsRoot, workspacePath);
  if (relativeWorkspace === "" || relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
    throw new Error("workspace path must stay inside runsRoot");
  }
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(workspacePath, { recursive: true });
  await pipeGitArchive(source.repositoryPath, source.baseRevision, workspacePath);
  await run("git", ["init", "-q"], { cwd: workspacePath });
  await run("git", ["config", "user.email", "memory-eval@example.invalid"], { cwd: workspacePath });
  await run("git", ["config", "user.name", "Memory Eval"], { cwd: workspacePath });
  await run("git", ["add", "-A"], { cwd: workspacePath });
  await run("git", ["commit", "-q", "-m", "baseline"], { cwd: workspacePath });
  const baselineCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: workspacePath })).stdout.trim();
  return { workspacePath, baselineCommit };
}

async function diffHash(workspacePath) {
  const diff = (await run("git", ["diff", "--binary", "HEAD"], { cwd: workspacePath })).stdout;
  return createHash("sha256").update(diff).digest("hex");
}

async function writeDiff(workspacePath, outPath) {
  await mkdir(path.dirname(outPath), { recursive: true });
  const diff = (await run("git", ["diff", "--binary", "HEAD"], { cwd: workspacePath })).stdout;
  await writeFile(outPath, diff);
}

export { diffHash, isSafeRunKey, materializeMemoryWorkspace, writeDiff };
