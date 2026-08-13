import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function assertInsideRoot(rootRealPath, candidateRealPath) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`resolved repository path escapes source root: ${candidateRealPath}`);
  }
}

async function assertCommitExists(repositoryPath, revision, fieldName) {
  const result = await runGit(["-C", repositoryPath, "cat-file", "-e", `${revision}^{commit}`], process.cwd());
  if (result.status !== 0) {
    throw new Error(`${fieldName} not found in resolved repository ${repositoryPath}: ${revision}`);
  }
}

async function resolveSourceRepositoryRoot({ sourceRepositoryRoot, tasks }) {
  if (!sourceRepositoryRoot) return { tasks, sourceRepositoryRoot: null, resolvedRepositories: [] };

  const rootRealPath = await realpath(path.resolve(sourceRepositoryRoot));
  const resolvedRepositories = [];
  const resolvedTasks = [];
  for (const task of tasks) {
    const originalPath = task.originalRepositoryPath;
    if (typeof originalPath !== "string" || originalPath.trim().length === 0) {
      throw new Error(`${task.taskId}: originalRepositoryPath is required when --source-repository-root is used`);
    }
    const originalBasename = path.basename(originalPath);
    const candidatePath = path.join(rootRealPath, originalBasename);
    const candidateRealPath = await realpath(candidatePath);
    assertInsideRoot(rootRealPath, candidateRealPath);
    if (path.basename(candidateRealPath) !== originalBasename) {
      throw new Error(`${task.taskId}: resolved basename does not match source lock originalRepositoryPath`);
    }
    await assertCommitExists(candidateRealPath, task.baseRevision, `${task.taskId}.baseRevision`);
    await assertCommitExists(candidateRealPath, task.targetRevision, `${task.taskId}.targetRevision`);
    const resolution = {
      taskId: task.taskId,
      originalRepositoryPath: originalPath,
      originalRepositoryBasename: originalBasename,
      sourceRepositoryRoot: rootRealPath,
      resolvedRepositoryPath: candidateRealPath,
      baseRevision: task.baseRevision,
      targetRevision: task.targetRevision,
    };
    resolvedRepositories.push(resolution);
    resolvedTasks.push({ ...task, repositoryPath: candidateRealPath, sourceRepositoryResolution: resolution });
  }
  return { tasks: resolvedTasks, sourceRepositoryRoot: rootRealPath, resolvedRepositories };
}

export { resolveSourceRepositoryRoot };
