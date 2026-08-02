#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const AUDIENCES = new Set(["human", "ai"]);
const SUITE_SCHEMA_VERSION = "kg-eval-suite/v1";
const DIFFICULTIES = new Set(["L1", "L2", "L3", "L4", "L5"]);
const ANSWERABILITIES = new Set(["answerable", "insufficient-source"]);
const SOURCE_TYPES = new Set(["post", "comment"]);
const POST_SOURCE_KEYS = new Set(["id", "type", "task", "postId"]);
const COMMENT_SOURCE_KEYS = new Set(["id", "type", "task", "postId", "commentId"]);
const GRAPH_CHECK_KEYS = new Set(["anchor", "depth", "requiredNodes", "requiredRelationships"]);
const RELATIONSHIP_CHECK_KEYS = new Set(["type", "start", "end"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite" || arg === "--data-root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.suite) {
    throw new Error("--suite is required");
  }
  if (!args["data-root"]) {
    throw new Error("--data-root is required");
  }
  return { suitePath: args.suite, dataRoot: args["data-root"] };
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function add(errors, questionId, fieldPath, message) {
  const prefix = questionId ? `${questionId} ${fieldPath}` : fieldPath;
  errors.push(`${prefix}: ${message}`);
}

function requireText(errors, object, field, fieldPath, questionId = null) {
  if (!hasText(object[field])) {
    add(errors, questionId, fieldPath, "required non-empty string");
  }
}

function requireArray(errors, object, field, fieldPath, questionId = null) {
  if (!Array.isArray(object[field])) {
    add(errors, questionId, fieldPath, "required array");
    return [];
  }
  return object[field];
}

function validateAllowedKeys(errors, questionId, fieldPath, object, allowedKeys) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      add(errors, questionId, `${fieldPath}.${key}`, "unexpected field");
    }
  }
}

async function validateSourceRef(errors, dataRoot, project, questionId, index, sourceRef) {
  const fieldPath = `sourceRefs[${index}]`;
  if (!isPlainObject(sourceRef)) {
    add(errors, questionId, fieldPath, "required object");
    return;
  }
  if (!hasText(sourceRef.id)) {
    add(errors, questionId, `${fieldPath}.id`, "required non-empty string");
  }
  const type = sourceRef.type;
  if (!SOURCE_TYPES.has(type)) {
    add(errors, questionId, `${fieldPath}.type`, "must be post or comment");
  }
  validateAllowedKeys(errors, questionId, fieldPath, sourceRef, type === "comment" ? COMMENT_SOURCE_KEYS : POST_SOURCE_KEYS);
  const task = sourceRef.task;
  if (!Number.isInteger(task)) {
    add(errors, questionId, `${fieldPath}.task`, "required integer task number");
    return;
  }
  if (sourceRef.postId !== undefined && !hasText(sourceRef.postId)) {
    add(errors, questionId, `${fieldPath}.postId`, "must be a non-empty string when present");
  }
  if (type === "post" && sourceRef.commentId !== undefined) {
    add(errors, questionId, `${fieldPath}.commentId`, "only comment sourceRefs may declare commentId");
  }

  const postPath = path.join(dataRoot, "raw", project, "posts", `${task}.json`);
  let raw;
  try {
    raw = await readJson(postPath);
  } catch (error) {
    add(errors, questionId, fieldPath, `raw post not found or unreadable: ${postPath}`);
    return;
  }

  if (raw?.post?.number !== task) {
    add(errors, questionId, `${fieldPath}.task`, `does not match post.number in ${postPath}`);
  }
  if (sourceRef.postId !== undefined && String(raw?.post?.id) !== String(sourceRef.postId)) {
    add(errors, questionId, `${fieldPath}.postId`, "does not match post.id");
  }
  if (type === "comment") {
    if (!hasText(sourceRef.commentId)) {
      add(errors, questionId, `${fieldPath}.commentId`, "required for comment sourceRef");
      return;
    }
    const comments = Array.isArray(raw?.comments) ? raw.comments : [];
    if (!comments.some((comment) => String(comment?.id) === String(sourceRef.commentId))) {
      add(errors, questionId, `${fieldPath}.commentId`, "does not exist in comments[].id");
    }
  }
}

function validateSourceIdArray(errors, questionId, owner, field, items, sourceIds, { requireNonEmpty = false } = {}) {
  if (!Array.isArray(items)) {
    add(errors, questionId, `${owner}.${field}`, "required array");
    return [];
  }
  if (requireNonEmpty && items.length === 0) {
    add(errors, questionId, `${owner}.${field}`, "must contain at least one item");
  }
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!hasText(item)) {
      add(errors, questionId, `${owner}.${field}[${i}]`, "must be a non-empty sourceRef id string");
      continue;
    }
    if (!sourceIds.has(item)) {
      add(errors, questionId, `${owner}.${field}[${i}]`, `references undeclared sourceRef: ${item}`);
    }
  }
  return items;
}

function validateStringArray(errors, questionId, field, items, { requireNonEmpty = false } = {}) {
  if (!Array.isArray(items)) {
    add(errors, questionId, field, "required array");
    return [];
  }
  if (requireNonEmpty && items.length === 0) {
    add(errors, questionId, field, "must contain at least one item");
  }
  for (let i = 0; i < items.length; i += 1) {
    if (!hasText(items[i])) {
      add(errors, questionId, `${field}[${i}]`, "must be a non-empty string");
    }
  }
  return items;
}

function validateReferenceArray(errors, question, field, sourceIds) {
  const items = requireArray(errors, question, field, field, question.id);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!hasText(item)) {
      add(errors, question.id, `${field}[${i}]`, "must be a non-empty sourceRef id string");
      continue;
    }
    if (!sourceIds.has(item)) {
      add(errors, question.id, `${field}[${i}]`, `references undeclared sourceRef: ${item}`);
    }
  }
  return items;
}

function validateGraphChecks(errors, questionId, graphChecks, sourceIds) {
  if (!Array.isArray(graphChecks)) {
    add(errors, questionId, "graphChecks", "required array");
    return [];
  }
  for (let i = 0; i < graphChecks.length; i += 1) {
    const check = graphChecks[i];
    const fieldPath = `graphChecks[${i}]`;
    if (!isPlainObject(check)) {
      add(errors, questionId, fieldPath, "required object");
      continue;
    }
    validateAllowedKeys(errors, questionId, fieldPath, check, GRAPH_CHECK_KEYS);
    if (!hasText(check.anchor)) {
      add(errors, questionId, `${fieldPath}.anchor`, "required non-empty sourceRef id string");
    } else if (!sourceIds.has(check.anchor)) {
      add(errors, questionId, `${fieldPath}.anchor`, `references undeclared sourceRef: ${check.anchor}`);
    }
    if (!Number.isInteger(check.depth) || check.depth < 1 || check.depth > 5) {
      add(errors, questionId, `${fieldPath}.depth`, "must be an integer from 1 to 5");
    }
    validateSourceIdArray(errors, questionId, fieldPath, "requiredNodes", check.requiredNodes, sourceIds);
    if (!Array.isArray(check.requiredRelationships)) {
      add(errors, questionId, `${fieldPath}.requiredRelationships`, "required array");
      continue;
    }
    for (let relationshipIndex = 0; relationshipIndex < check.requiredRelationships.length; relationshipIndex += 1) {
      const relationship = check.requiredRelationships[relationshipIndex];
      const relationshipPath = `${fieldPath}.requiredRelationships[${relationshipIndex}]`;
      if (!isPlainObject(relationship)) {
        add(errors, questionId, relationshipPath, "required object");
        continue;
      }
      validateAllowedKeys(errors, questionId, relationshipPath, relationship, RELATIONSHIP_CHECK_KEYS);
      if (!hasText(relationship.type)) {
        add(errors, questionId, `${relationshipPath}.type`, "required non-empty string");
      }
      for (const endpoint of ["start", "end"]) {
        if (!hasText(relationship[endpoint])) {
          add(errors, questionId, `${relationshipPath}.${endpoint}`, "required non-empty sourceRef id string");
        } else if (!sourceIds.has(relationship[endpoint])) {
          add(errors, questionId, `${relationshipPath}.${endpoint}`, `references undeclared sourceRef: ${relationship[endpoint]}`);
        }
      }
    }
  }
  return graphChecks;
}

async function validateSuite(suitePath, dataRoot) {
  const errors = [];
  const suite = await readJson(suitePath);
  if (!isPlainObject(suite)) {
    return ["$: required object"];
  }

  for (const field of ["schemaVersion", "project", "flowId", "title", "sourceSnapshot"]) {
    requireText(errors, suite, field, field);
  }
  if (hasText(suite.schemaVersion) && suite.schemaVersion !== SUITE_SCHEMA_VERSION) {
    add(errors, null, "schemaVersion", `must be ${SUITE_SCHEMA_VERSION}`);
  }
  const questions = requireArray(errors, suite, "questions", "questions");
  if (questions.length < 12) {
    add(errors, null, "questions", "must contain at least 12 questions");
  }

  const ids = new Set();
  const audiences = new Set();
  const difficulties = new Set();

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const questionId = hasText(question?.id) ? question.id : `questions[${i}]`;
    if (!isPlainObject(question)) {
      add(errors, questionId, `questions[${i}]`, "required object");
      continue;
    }

    for (const field of ["id", "question"]) {
      requireText(errors, question, field, field, questionId);
    }
    if (ids.has(question.id)) {
      add(errors, questionId, "id", "must be unique within suite");
    }
    ids.add(question.id);

    if (!AUDIENCES.has(question.audience)) {
      add(errors, questionId, "audience", "must be human or ai");
    } else {
      audiences.add(question.audience);
    }
    if (!DIFFICULTIES.has(question.difficulty)) {
      add(errors, questionId, "difficulty", "must be L1, L2, L3, L4, or L5");
    } else {
      difficulties.add(question.difficulty);
    }
    if (!ANSWERABILITIES.has(question.answerability)) {
      add(errors, questionId, "answerability", "must be answerable or insufficient-source");
    }

    const sourceRefs = requireArray(errors, question, "sourceRefs", "sourceRefs", questionId);
    const sourceIds = new Set();
    for (let sourceRefIndex = 0; sourceRefIndex < sourceRefs.length; sourceRefIndex += 1) {
      const sourceRef = sourceRefs[sourceRefIndex];
      if (hasText(sourceRef?.id)) {
        if (sourceIds.has(sourceRef.id)) {
          add(errors, questionId, `sourceRefs[${sourceRefIndex}].id`, "must be unique within question");
        }
        sourceIds.add(sourceRef.id);
      }
    }
    const graphChecks = validateGraphChecks(errors, questionId, question.graphChecks, sourceIds);
    validateStringArray(errors, questionId, "expectedClaims", question.expectedClaims, { requireNonEmpty: true });
    const requiredEvidence = validateReferenceArray(errors, question, "requiredEvidence", sourceIds);
    validateReferenceArray(errors, question, "supportingEvidence", sourceIds);
    validateReferenceArray(errors, question, "orderedEvents", sourceIds);
    const forbiddenClaims = validateStringArray(errors, questionId, "forbiddenClaims", question.forbiddenClaims);

    if (question.answerability === "answerable") {
      if (sourceRefs.length === 0) {
        add(errors, questionId, "sourceRefs", "answerable questions require at least one sourceRef");
      }
      if (requiredEvidence.length === 0) {
        add(errors, questionId, "requiredEvidence", "answerable questions require at least one requiredEvidence item");
      }
      if (graphChecks.length === 0) {
        add(errors, questionId, "graphChecks", "answerable questions require at least one graphCheck");
      }
    }
    if (question.answerability === "insufficient-source") {
      if (requiredEvidence.length > 0) {
        add(errors, questionId, "requiredEvidence", "insufficient-source questions must not declare requiredEvidence");
      }
      if (forbiddenClaims.length === 0) {
        add(errors, questionId, "forbiddenClaims", "insufficient-source questions require at least one forbiddenClaim");
      }
    }

    for (let refIndex = 0; refIndex < sourceRefs.length; refIndex += 1) {
      await validateSourceRef(errors, dataRoot, suite.project, questionId, refIndex, sourceRefs[refIndex]);
    }
  }

  for (const audience of AUDIENCES) {
    if (!audiences.has(audience)) {
      add(errors, null, "questions", `must include audience=${audience}`);
    }
  }
  for (const difficulty of DIFFICULTIES) {
    if (!difficulties.has(difficulty)) {
      add(errors, null, "questions", `must include difficulty=${difficulty}`);
    }
  }
  return errors;
}

async function main() {
  try {
    const { suitePath, dataRoot } = parseArgs(process.argv.slice(2));
    const errors = await validateSuite(suitePath, dataRoot);
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { validateSuite };
