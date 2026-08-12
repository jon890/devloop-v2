import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const MEMORY_SUITE_SCHEMA_VERSION = "memory-eval-suite/v1";
const TASK_CATEGORIES = new Set(["code-only", "experience-needed"]);
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "project", "suiteId", "title", "sourceSnapshot", "tasks"]);
const TASK_KEYS = new Set(["id", "category", "taskType", "sourceLockKey", "expectedTrigger", "tags"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function requireText(errors, object, field, path = field) {
  if (!hasText(object[field])) {
    add(errors, path, "required non-empty string");
  }
}

function validateAllowedKeys(errors, object, allowedKeys, path) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      add(errors, path === "$" ? key : `${path}.${key}`, "unexpected field");
    }
  }
}

function validateMemorySuiteObject(suite) {
  const errors = [];
  if (!isPlainObject(suite)) {
    return ["$: required object"];
  }
  validateAllowedKeys(errors, suite, TOP_LEVEL_KEYS, "$");

  for (const field of ["schemaVersion", "project", "suiteId", "title", "sourceSnapshot"]) {
    requireText(errors, suite, field);
  }
  if (hasText(suite.schemaVersion) && suite.schemaVersion !== MEMORY_SUITE_SCHEMA_VERSION) {
    add(errors, "schemaVersion", `must be ${MEMORY_SUITE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(suite.tasks)) {
    add(errors, "tasks", "required array");
    return errors;
  }
  if (suite.tasks.length === 0) {
    add(errors, "tasks", "must contain at least one task");
  }

  const ids = new Set();
  const sourceLockKeys = new Set();
  const categories = new Map();
  let relationshipHeavyCount = 0;

  for (let index = 0; index < suite.tasks.length; index += 1) {
    const task = suite.tasks[index];
    const path = `tasks[${index}]`;
    if (!isPlainObject(task)) {
      add(errors, path, "required object");
      continue;
    }
    validateAllowedKeys(errors, task, TASK_KEYS, path);
    for (const field of ["id", "category", "taskType", "sourceLockKey", "expectedTrigger"]) {
      requireText(errors, task, field, `${path}.${field}`);
    }
    if (hasText(task.id)) {
      if (ids.has(task.id)) {
        add(errors, `${path}.id`, "must be unique");
      }
      ids.add(task.id);
    }
    if (hasText(task.sourceLockKey)) {
      if (sourceLockKeys.has(task.sourceLockKey)) {
        add(errors, `${path}.sourceLockKey`, "must be unique");
      }
      sourceLockKeys.add(task.sourceLockKey);
    }
    if (hasText(task.category)) {
      if (!TASK_CATEGORIES.has(task.category)) {
        add(errors, `${path}.category`, "must be code-only or experience-needed");
      }
      categories.set(task.category, (categories.get(task.category) ?? 0) + 1);
    }
    if (!Array.isArray(task.tags)) {
      add(errors, `${path}.tags`, "required array");
    } else {
      for (let tagIndex = 0; tagIndex < task.tags.length; tagIndex += 1) {
        if (!hasText(task.tags[tagIndex])) {
          add(errors, `${path}.tags[${tagIndex}]`, "must be a non-empty string");
        }
      }
      if (task.tags.includes("relationship-heavy")) {
        relationshipHeavyCount += 1;
      }
    }
  }

  for (const category of TASK_CATEGORIES) {
    if ((categories.get(category) ?? 0) < 2) {
      add(errors, "tasks", `must include at least two category=${category} tasks`);
    }
  }
  if (relationshipHeavyCount < 1) {
    add(errors, "tasks", "must include at least one relationship-heavy task");
  }
  return errors;
}

async function loadMemorySuite(suitePath) {
  const suite = await readJson(suitePath);
  const errors = validateMemorySuiteObject(suite);
  return { suite, errors, hash: canonicalHash(suite) };
}

export { MEMORY_SUITE_SCHEMA_VERSION, canonicalHash, canonicalJson, hasText, isPlainObject, loadMemorySuite, validateMemorySuiteObject };
