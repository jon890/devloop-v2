import path from "node:path";
import { readFile } from "node:fs/promises";
import { canonicalHash, hasText, isPlainObject } from "./suite.mjs";

const SOURCE_LOCK_SCHEMA_VERSION = "memory-source-lock/v1";
const SHA40 = /^[0-9a-f]{40}$/i;

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath}: invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function isInternalUrl(value) {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function validateStringArray(errors, value, fieldPath, { requireNonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    add(errors, fieldPath, "required array");
    return [];
  }
  if (requireNonEmpty && value.length === 0) {
    add(errors, fieldPath, "must contain at least one item");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!hasText(value[index])) {
      add(errors, `${fieldPath}[${index}]`, "must be a non-empty string");
    }
  }
  return value;
}

function validateAllowedPath(errors, allowedPath, fieldPath) {
  if (!hasText(allowedPath)) {
    add(errors, fieldPath, "must be a non-empty string");
    return;
  }
  if (path.isAbsolute(allowedPath) || allowedPath.includes("\0")) {
    add(errors, fieldPath, "must be a relative repository path");
  }
  const normalized = path.posix.normalize(allowedPath.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    add(errors, fieldPath, "must stay inside the repository");
  }
}

function validateSourceLockObject(sourceLock) {
  const errors = [];
  if (!isPlainObject(sourceLock)) {
    return ["$: required object"];
  }
  for (const field of ["schemaVersion", "suiteId", "sourceSnapshot"]) {
    if (!hasText(sourceLock[field])) {
      add(errors, field, "required non-empty string");
    }
  }
  if (hasText(sourceLock.schemaVersion) && sourceLock.schemaVersion !== SOURCE_LOCK_SCHEMA_VERSION) {
    add(errors, "schemaVersion", `must be ${SOURCE_LOCK_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(sourceLock.tasks)) {
    add(errors, "tasks", "required array");
    return errors;
  }

  const taskIds = new Set();
  const sourceLockKeys = new Set();
  for (let index = 0; index < sourceLock.tasks.length; index += 1) {
    const task = sourceLock.tasks[index];
    const fieldPath = `tasks[${index}]`;
    if (!isPlainObject(task)) {
      add(errors, fieldPath, "required object");
      continue;
    }
    for (const field of ["taskId", "sourceLockKey", "repositoryPath", "sourceUrl", "baseRevision", "targetRevision", "prompt", "oracleQuery"]) {
      if (!hasText(task[field])) {
        add(errors, `${fieldPath}.${field}`, "required non-empty string");
      }
    }
    if (hasText(task.taskId)) {
      if (taskIds.has(task.taskId)) {
        add(errors, `${fieldPath}.taskId`, "must be unique");
      }
      taskIds.add(task.taskId);
    }
    if (hasText(task.sourceLockKey)) {
      if (sourceLockKeys.has(task.sourceLockKey)) {
        add(errors, `${fieldPath}.sourceLockKey`, "must be unique");
      }
      sourceLockKeys.add(task.sourceLockKey);
    }
    if (hasText(task.repositoryPath) && !path.isAbsolute(task.repositoryPath)) {
      add(errors, `${fieldPath}.repositoryPath`, "must be an absolute path");
    }
    if (hasText(task.sourceUrl) && !isInternalUrl(task.sourceUrl)) {
      add(errors, `${fieldPath}.sourceUrl`, "must be an http(s) URL");
    }
    for (const field of ["baseRevision", "targetRevision"]) {
      if (hasText(task[field]) && !SHA40.test(task[field])) {
        add(errors, `${fieldPath}.${field}`, "must be a 40-character git revision");
      }
    }
    const allowedPaths = validateStringArray(errors, task.allowedPaths, `${fieldPath}.allowedPaths`, { requireNonEmpty: true });
    allowedPaths.forEach((allowedPath, allowedIndex) => validateAllowedPath(errors, allowedPath, `${fieldPath}.allowedPaths[${allowedIndex}]`));
    validateStringArray(errors, task.validationCommand, `${fieldPath}.validationCommand`, { requireNonEmpty: true });
  }
  return errors;
}

function validateSuiteSourceLockPair(suite, sourceLock) {
  const errors = [];
  if (suite.suiteId !== sourceLock.suiteId) {
    add(errors, "suiteId", "public suite and source lock must match");
  }
  const publicByTaskId = new Map();
  const publicByKey = new Map();
  for (const task of suite.tasks ?? []) {
    publicByTaskId.set(task.id, task);
    publicByKey.set(task.sourceLockKey, task);
  }
  const privateByTaskId = new Map();
  const privateByKey = new Map();
  for (const task of sourceLock.tasks ?? []) {
    privateByTaskId.set(task.taskId, task);
    privateByKey.set(task.sourceLockKey, task);
  }
  for (const task of suite.tasks ?? []) {
    const byTaskId = privateByTaskId.get(task.id);
    if (!byTaskId) {
      add(errors, `task ${task.id}`, "missing from source lock");
      continue;
    }
    if (byTaskId.sourceLockKey !== task.sourceLockKey) {
      add(errors, `task ${task.id}.sourceLockKey`, "does not match source lock task");
    }
    if (privateByKey.get(task.sourceLockKey)?.taskId !== task.id) {
      add(errors, `task ${task.id}.sourceLockKey`, "does not map bijectively to task id");
    }
  }
  for (const task of sourceLock.tasks ?? []) {
    if (!publicByTaskId.has(task.taskId)) {
      add(errors, `sourceLock task ${task.taskId}`, "missing from public suite");
    }
    if (!publicByKey.has(task.sourceLockKey)) {
      add(errors, `sourceLock key ${task.sourceLockKey}`, "missing from public suite");
    }
  }
  return errors;
}

async function loadSourceLock(sourceLockPath) {
  const sourceLock = await readJson(sourceLockPath);
  const errors = validateSourceLockObject(sourceLock);
  return { sourceLock, errors, hash: canonicalHash(sourceLock) };
}

export { SOURCE_LOCK_SCHEMA_VERSION, loadSourceLock, validateSourceLockObject, validateSuiteSourceLockPair };
