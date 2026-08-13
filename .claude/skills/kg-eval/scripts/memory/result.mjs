import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MEMORY_RUN_SCHEMA_VERSION = "memory-eval-run/v1";

function attemptKey(attempt) {
  return `${attempt.taskId}:${attempt.condition}:${attempt.repetition}`;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateAttemptShape(attempt, index = null) {
  const prefix = index === null ? "attempt" : `attempts[${index}]`;
  if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) {
    throw new Error(`${prefix}: required object`);
  }
  for (const field of ["taskId", "condition"]) {
    if (!hasText(attempt[field])) {
      throw new Error(`${prefix}.${field}: required non-empty string`);
    }
  }
  if (!Number.isInteger(attempt.repetition) || attempt.repetition < 1) {
    throw new Error(`${prefix}.repetition: must be a positive integer`);
  }
}

function validateAttempts(attempts) {
  if (!Array.isArray(attempts)) {
    throw new Error("existing run attempts must be an array");
  }
  const keys = new Set();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    validateAttemptShape(attempt, index);
    const key = attemptKey(attempt);
    if (keys.has(key)) {
      throw new Error(`attempts[${index}]: duplicate attempt key ${key}`);
    }
    keys.add(key);
  }
}

function validateAvailabilityFailure(failure, index = null) {
  const prefix = index === null ? "availabilityFailure" : `availabilityFailures[${index}]`;
  if (failure === null || typeof failure !== "object" || Array.isArray(failure)) {
    throw new Error(`${prefix}: required object`);
  }
  const keys = Object.keys(failure).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["condition", "normalizedCode", "repetition", "taskId"])) {
    throw new Error(`${prefix}: must contain exactly taskId, condition, repetition, normalizedCode`);
  }
  for (const field of ["taskId", "condition", "normalizedCode"]) {
    if (!hasText(failure[field])) {
      throw new Error(`${prefix}.${field}: required non-empty string`);
    }
  }
  if (!Number.isInteger(failure.repetition) || failure.repetition < 1) {
    throw new Error(`${prefix}.repetition: must be a positive integer`);
  }
}

function validateAvailabilityFailures(failures) {
  if (failures === undefined) return;
  if (!Array.isArray(failures)) {
    throw new Error("existing run availabilityFailures must be an array");
  }
  for (let index = 0; index < failures.length; index += 1) {
    validateAvailabilityFailure(failures[index], index);
  }
}

function canonicalExecutionPlan(executionPlan) {
  if (executionPlan === null || typeof executionPlan !== "object" || Array.isArray(executionPlan)) {
    throw new Error("executionPlan must be an object");
  }
  if (!Array.isArray(executionPlan.conditions) || executionPlan.conditions.length === 0) {
    throw new Error("executionPlan.conditions must contain at least one condition");
  }
  const conditions = executionPlan.conditions.map((condition, index) => {
    if (!hasText(condition)) throw new Error(`executionPlan.conditions[${index}]: required non-empty string`);
    return condition;
  });
  if (!Number.isInteger(executionPlan.repeats) || executionPlan.repeats < 1) {
    throw new Error("executionPlan.repeats must be a positive integer");
  }
  if (!hasText(executionPlan.schedule)) {
    throw new Error("executionPlan.schedule: required non-empty string");
  }
  if (typeof executionPlan.requireExpectedTrigger !== "boolean") {
    throw new Error("executionPlan.requireExpectedTrigger must be boolean");
  }
  if (!Number.isInteger(executionPlan.timeoutMs) || executionPlan.timeoutMs < 1) {
    throw new Error("executionPlan.timeoutMs must be a positive integer");
  }
  if (executionPlan.maxOutputBytes !== null && (!Number.isInteger(executionPlan.maxOutputBytes) || executionPlan.maxOutputBytes < 1)) {
    throw new Error("executionPlan.maxOutputBytes must be null or a positive integer");
  }
  return {
    conditions,
    repeats: executionPlan.repeats,
    schedule: executionPlan.schedule,
    requireExpectedTrigger: executionPlan.requireExpectedTrigger,
    timeoutMs: executionPlan.timeoutMs,
    maxOutputBytes: executionPlan.maxOutputBytes,
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  if (Array.isArray(value?.attempts)) {
    validateAttempts(value.attempts);
  }
  validateAvailabilityFailures(value?.availabilityFailures);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  JSON.parse(await readFile(tmpPath, "utf8"));
  await rename(tmpPath, filePath);
}

async function acquireRunLock(outPath) {
  const lockPath = `${outPath}.lock`;
  await mkdir(path.dirname(outPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    await handle.writeFile(`${process.pid}\n`);
    return { lockPath, handle };
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`output is locked: ${lockPath}`);
    }
    throw error;
  }
}

async function releaseRunLock(lock) {
  if (!lock) return;
  await lock.handle?.close();
  await rm(lock.lockPath, { force: true });
}

function newMemoryRun(conditions) {
  const sourceRepositoryResolution = canonicalSourceRepositoryResolution(conditions);
  return {
    schemaVersion: MEMORY_RUN_SCHEMA_VERSION,
    suitePath: conditions.suitePath,
    sourceLockPath: conditions.sourceLockPath,
    suiteHash: conditions.suiteHash,
    sourceLockHash: conditions.sourceLockHash,
    taskInputs: canonicalTaskInputs(conditions.taskInputs),
    memoryIndexHash: conditions.memoryIndexHash,
    ...(sourceRepositoryResolution ? sourceRepositoryResolution : {}),
    executionPlan: canonicalExecutionPlan(conditions.executionPlan),
    agent: conditions.agent,
    agentOptions: canonicalAgentOptions(conditions.agentOptions),
    startedAt: new Date().toISOString(),
    attempts: [],
    availabilityFailures: [],
  };
}

function canonicalAgentOptions(agentOptions) {
  if (agentOptions === null || typeof agentOptions !== "object" || Array.isArray(agentOptions)) {
    return null;
  }
  return {
    model: agentOptions.model ?? null,
    effort: agentOptions.effort ?? null,
    permissionMode: agentOptions.permissionMode ?? null,
  };
}

function canonicalTaskInputs(taskInputs) {
  if (!Array.isArray(taskInputs) || taskInputs.length === 0) {
    throw new Error("taskInputs must contain at least one task input");
  }
  return taskInputs
    .map((input, index) => {
      if (!hasText(input?.taskId)) throw new Error(`taskInputs[${index}].taskId: required non-empty string`);
      if (!hasText(input?.baseRevision)) throw new Error(`taskInputs[${index}].baseRevision: required non-empty string`);
      if (!Array.isArray(input?.validationCommand) || input.validationCommand.length === 0) {
        throw new Error(`taskInputs[${index}].validationCommand: required non-empty array`);
      }
      return {
        taskId: input.taskId,
        baseRevision: input.baseRevision,
        validationCommand: input.validationCommand,
      };
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function canonicalSourceRepositoryResolution(run) {
  if (run.sourceRepositoryRoot === undefined && run.resolvedRepositories === undefined) return null;
  if (!hasText(run.sourceRepositoryRoot)) {
    throw new Error("sourceRepositoryRoot: required non-empty string when source repository resolution is present");
  }
  if (!path.isAbsolute(run.sourceRepositoryRoot)) {
    throw new Error("sourceRepositoryRoot: must be an absolute path");
  }
  if (!Array.isArray(run.resolvedRepositories) || run.resolvedRepositories.length === 0) {
    throw new Error("resolvedRepositories: required non-empty array when sourceRepositoryRoot is present");
  }
  const taskIds = new Set();
  const resolvedRepositories = run.resolvedRepositories
    .map((resolution, index) => {
      if (resolution === null || typeof resolution !== "object" || Array.isArray(resolution)) {
        throw new Error(`resolvedRepositories[${index}]: required object`);
      }
      for (const field of ["taskId", "originalRepositoryPath", "originalRepositoryBasename", "sourceRepositoryRoot", "resolvedRepositoryPath", "baseRevision", "targetRevision"]) {
        if (!hasText(resolution[field])) {
          throw new Error(`resolvedRepositories[${index}].${field}: required non-empty string`);
        }
      }
      if (taskIds.has(resolution.taskId)) {
        throw new Error(`resolvedRepositories[${index}].taskId: must be unique`);
      }
      taskIds.add(resolution.taskId);
      for (const field of ["originalRepositoryPath", "sourceRepositoryRoot", "resolvedRepositoryPath"]) {
        if (!path.isAbsolute(resolution[field])) {
          throw new Error(`resolvedRepositories[${index}].${field}: must be an absolute path`);
        }
      }
      if (resolution.sourceRepositoryRoot !== run.sourceRepositoryRoot) {
        throw new Error(`resolvedRepositories[${index}].sourceRepositoryRoot: must match sourceRepositoryRoot`);
      }
      if (path.basename(resolution.originalRepositoryPath) !== resolution.originalRepositoryBasename) {
        throw new Error(`resolvedRepositories[${index}].originalRepositoryBasename: must match originalRepositoryPath basename`);
      }
      if (path.basename(resolution.resolvedRepositoryPath) !== resolution.originalRepositoryBasename) {
        throw new Error(`resolvedRepositories[${index}].resolvedRepositoryPath: basename must match originalRepositoryBasename`);
      }
      return {
        taskId: resolution.taskId,
        originalRepositoryPath: resolution.originalRepositoryPath,
        originalRepositoryBasename: resolution.originalRepositoryBasename,
        sourceRepositoryRoot: resolution.sourceRepositoryRoot,
        resolvedRepositoryPath: resolution.resolvedRepositoryPath,
        baseRevision: resolution.baseRevision,
        targetRevision: resolution.targetRevision,
      };
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    sourceRepositoryRoot: run.sourceRepositoryRoot,
    resolvedRepositories,
  };
}

function comparableRunFields(run) {
  const sourceRepositoryResolution = canonicalSourceRepositoryResolution(run);
  return {
    schemaVersion: run.schemaVersion,
    suiteHash: run.suiteHash,
    sourceLockHash: run.sourceLockHash,
    taskInputs: canonicalTaskInputs(run.taskInputs),
    memoryIndexHash: run.memoryIndexHash,
    sourceRepositoryRoot: sourceRepositoryResolution?.sourceRepositoryRoot ?? null,
    resolvedRepositories: sourceRepositoryResolution?.resolvedRepositories ?? null,
    executionPlan: canonicalExecutionPlan(run.executionPlan),
    agent: run.agent,
    agentOptions: canonicalAgentOptions(run.agentOptions),
  };
}

function assertConditionsMatch(existing, expected) {
  for (const field of ["agent", "agentOptions"]) {
    if (!Object.hasOwn(existing, field)) {
      throw new Error(`conditions differ: ${field}`);
    }
  }
  const left = comparableRunFields(existing);
  const right = comparableRunFields(expected);
  for (const key of Object.keys(right)) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      throw new Error(`conditions differ: ${key}`);
    }
  }
}

async function loadOrCreateMemoryRun(outPath, conditions) {
  const expected = newMemoryRun(conditions);
  const existing = await readJsonIfExists(outPath);
  if (!existing) {
    return expected;
  }
  assertConditionsMatch(existing, expected);
  validateAttempts(existing.attempts);
  validateAvailabilityFailures(existing.availabilityFailures);
  if (!Array.isArray(existing.availabilityFailures)) existing.availabilityFailures = [];
  return existing;
}

function appendMemoryAttempt(run, attempt) {
  validateAttemptShape(attempt);
  const key = attemptKey(attempt);
  const existingIndex = run.attempts.findIndex((item) => attemptKey(item) === key);
  if (existingIndex >= 0) {
    throw new Error(`duplicate attempt key ${key}`);
  }
  run.attempts.push(attempt);
}

function appendAvailabilityFailure(run, failure) {
  validateAvailabilityFailure(failure);
  if (!Array.isArray(run.availabilityFailures)) run.availabilityFailures = [];
  run.availabilityFailures.push(failure);
}

async function withMemoryRun(outPath, conditions, callback) {
  let lock;
  try {
    lock = await acquireRunLock(outPath);
    const run = await loadOrCreateMemoryRun(outPath, conditions);
    let dirty = false;
    const result = await callback({
      run,
      save: async () => {
        dirty = true;
        await writeJsonAtomic(outPath, run);
      },
      appendAttempt: async (attempt) => {
        appendMemoryAttempt(run, attempt);
        dirty = true;
        await writeJsonAtomic(outPath, run);
      },
      appendAvailabilityFailure: async (failure) => {
        appendAvailabilityFailure(run, failure);
        dirty = true;
        await writeJsonAtomic(outPath, run);
      },
    });
    if (dirty) await writeJsonAtomic(outPath, run);
    return result;
  } finally {
    await releaseRunLock(lock);
  }
}

export {
  MEMORY_RUN_SCHEMA_VERSION,
  acquireRunLock,
  appendAvailabilityFailure,
  appendMemoryAttempt,
  attemptKey,
  canonicalExecutionPlan,
  loadOrCreateMemoryRun,
  releaseRunLock,
  canonicalTaskInputs,
  canonicalAgentOptions,
  validateAvailabilityFailure,
  validateAvailabilityFailures,
  validateAttemptShape,
  validateAttempts,
  withMemoryRun,
  writeJsonAtomic,
};
