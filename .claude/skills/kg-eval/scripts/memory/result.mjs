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
  return {
    schemaVersion: MEMORY_RUN_SCHEMA_VERSION,
    suitePath: conditions.suitePath,
    sourceLockPath: conditions.sourceLockPath,
    suiteHash: conditions.suiteHash,
    sourceLockHash: conditions.sourceLockHash,
    baseRevision: conditions.baseRevision,
    validationCommand: conditions.validationCommand,
    memoryIndexHash: conditions.memoryIndexHash,
    startedAt: new Date().toISOString(),
    attempts: [],
  };
}

function comparableRunFields(run) {
  return {
    schemaVersion: run.schemaVersion,
    suiteHash: run.suiteHash,
    sourceLockHash: run.sourceLockHash,
    baseRevision: run.baseRevision,
    validationCommand: run.validationCommand,
    memoryIndexHash: run.memoryIndexHash,
  };
}

function assertConditionsMatch(existing, expected) {
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
  return existing;
}

function upsertMemoryAttempt(run, attempt) {
  validateAttemptShape(attempt);
  const key = attemptKey(attempt);
  const existingIndex = run.attempts.findIndex((item) => attemptKey(item) === key);
  if (existingIndex >= 0) {
    run.attempts[existingIndex] = attempt;
    return;
  }
  run.attempts.push(attempt);
}

async function withMemoryRun(outPath, conditions, callback) {
  let lock;
  try {
    lock = await acquireRunLock(outPath);
    const run = await loadOrCreateMemoryRun(outPath, conditions);
    const result = await callback({
      run,
      save: async () => writeJsonAtomic(outPath, run),
      upsert: async (attempt) => {
        upsertMemoryAttempt(run, attempt);
        await writeJsonAtomic(outPath, run);
      },
    });
    await writeJsonAtomic(outPath, run);
    return result;
  } finally {
    await releaseRunLock(lock);
  }
}

export {
  MEMORY_RUN_SCHEMA_VERSION,
  acquireRunLock,
  attemptKey,
  loadOrCreateMemoryRun,
  releaseRunLock,
  upsertMemoryAttempt,
  validateAttemptShape,
  validateAttempts,
  withMemoryRun,
  writeJsonAtomic,
};
