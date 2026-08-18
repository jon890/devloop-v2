#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadSourceLock } from "./source-lock.mjs";

const SECRET_FIELD_NAMES = new Set([
  "repositoryPath",
  "originalRepositoryPath",
  "repositoryUrl",
  "sourceUrl",
  "baseRevision",
  "targetRevision",
  "prompt",
  "diff",
  "transcript",
  "oracleQuery",
  "resolvedElementId",
  "graphBaseUrl",
  "apiBaseUrl",
]);

const PRIVATE_INPUT_FIELD_NAMES = new Set([
  "repositoryPath",
  "originalRepositoryPath",
  "repositoryUrl",
  "sourceUrl",
  "resolvedElementId",
  "graphBaseUrl",
  "apiBaseUrl",
  "graphFailureReason",
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--source-lock" && arg !== "--private-inputs" && arg !== "--paths") throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    args[arg.slice(2)] = value;
    index += 1;
  }
  if (!args["source-lock"] && !args["private-inputs"]) throw new Error("--source-lock or --private-inputs is required");
  if (!args.paths) throw new Error("--paths is required");
  return {
    sourceLockPath: args["source-lock"] ?? null,
    privateInputPaths: splitCsv(args["private-inputs"]),
    paths: args.paths
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function splitCsv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function addNeedle(needles, label, value) {
  if (!hasText(value)) return;
  const trimmed = value.trim();
  if (trimmed.length < 4) return;
  needles.push({ label, value: trimmed });
}

function internalDomainCandidates(urlText) {
  try {
    const host = new URL(urlText).hostname;
    if (!host.includes(".")) return [];
    const parts = host.split(".");
    const candidates = [host];
    if (parts.length >= 2) candidates.push(parts.slice(-2).join("."));
    if (parts.length >= 3) candidates.push(parts.slice(-3).join("."));
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

function collectFromObject(value, needles, fieldPath = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFromObject(item, needles, `${fieldPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${fieldPath}.${key}`;
    if (SECRET_FIELD_NAMES.has(key) && hasText(child)) {
      addNeedle(needles, key, child);
      if (key.toLowerCase().includes("url")) {
        for (const domain of internalDomainCandidates(child)) addNeedle(needles, "internalDomain", domain);
      }
    }
    collectFromObject(child, needles, childPath);
  }
}

function collectPrivacyNeedles(sourceLock) {
  const needles = [];
  for (const root of commonRepositoryRoots(sourceLock.tasks ?? [])) {
    addNeedle(needles, "repositoryRoot", root);
  }
  collectFromObject(sourceLock, needles);
  const unique = new Map();
  for (const needle of needles) {
    const key = `${needle.label}\0${needle.value}`;
    if (!unique.has(key)) unique.set(key, needle);
  }
  return [...unique.values()];
}

function addUniqueNeedles(needles) {
  const unique = new Map();
  for (const needle of needles) {
    const key = `${needle.label}\0${needle.value}`;
    if (!unique.has(key)) unique.set(key, needle);
  }
  return [...unique.values()];
}

function collectPrivateInputNeedlesFromValue(value, needles, fieldPath = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPrivateInputNeedlesFromValue(item, needles, `${fieldPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${fieldPath}.${key}`;
    if (key === "query" && hasText(child)) addNeedle(needles, "privateQuery", child);
    if (PRIVATE_INPUT_FIELD_NAMES.has(key) && hasText(child)) {
      addNeedle(needles, key, child);
      if (key.toLowerCase().includes("url")) {
        for (const domain of internalDomainCandidates(child)) addNeedle(needles, "internalDomain", domain);
      }
    }
    if (key === "id" && hasText(child) && /(?:nodes|relationships)\[\d+\]$/.test(fieldPath)) addNeedle(needles, "graphElementId", child);
    if (key === "key" && hasText(child)) addNeedle(needles, "graphAnchorKey", child);
    if (key === "properties" && child && typeof child === "object") collectGraphPropertyNeedles(child, needles);
    if (/memoryids?$/i.test(key) && Array.isArray(child)) {
      for (const item of child) addNeedle(needles, "memoryId", item);
    }
    if (/memoryid$/i.test(key) && hasText(child)) addNeedle(needles, "memoryId", child);
    collectPrivateInputNeedlesFromValue(child, needles, childPath);
  }
}

function collectGraphPropertyNeedles(value, needles) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectGraphPropertyNeedles(item, needles));
    return;
  }
  if (!value || typeof value !== "object") {
    addNeedle(needles, "graphProperty", typeof value === "string" ? value : "");
    return;
  }
  for (const child of Object.values(value)) collectGraphPropertyNeedles(child, needles);
}

async function collectPrivateInputNeedles(privateInputPaths) {
  const needles = [];
  let existingInputs = 0;
  for (const inputPath of privateInputPaths) {
    try {
      await access(inputPath, constants.F_OK);
    } catch {
      continue;
    }
    existingInputs += 1;
    const text = await readFile(inputPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    collectPrivateInputNeedlesFromValue(parsed, needles);
  }
  if (privateInputPaths.length > 0 && existingInputs === 0) throw new Error("private inputs not found");
  return addUniqueNeedles(needles);
}

function commonRepositoryRoots(tasks) {
  const paths = tasks.map((task) => task.repositoryPath).filter(hasText).map((value) => path.resolve(value));
  if (paths.length === 0) return [];
  if (paths.length === 1) return [path.dirname(paths[0])];
  const splitPaths = paths.map((value) => value.split(path.sep).filter(Boolean));
  const common = [];
  for (let index = 0; ; index += 1) {
    const segment = splitPaths[0][index];
    if (!segment || splitPaths.some((parts) => parts[index] !== segment)) break;
    common.push(segment);
  }
  const commonRoot = `${path.sep}${common.join(path.sep)}`;
  return [commonRoot].filter((value) => value.length > 1);
}

async function scanPrivacy({ sourceLockPath = null, privateInputPaths = [], paths }) {
  let needles = [];
  if (sourceLockPath) {
    const loaded = await loadSourceLock(sourceLockPath);
    if (loaded.errors.length > 0) {
      throw new Error(`source lock validation failed with ${loaded.errors.length} error(s)`);
    }
    needles = needles.concat(collectPrivacyNeedles(loaded.sourceLock));
  }
  needles = addUniqueNeedles(needles.concat(await collectPrivateInputNeedles(privateInputPaths)));
  const violations = [];
  for (const filePath of paths) {
    const text = await readFile(filePath, "utf8");
    for (const needle of needles) {
      if (!text.includes(needle.value)) continue;
      violations.push({ path: filePath, label: needle.label });
    }
  }
  const result = {
    scannedPaths: paths.length,
    sensitiveNeedles: needles.length,
    violations: violations.length,
    violationLabels: [...new Set(violations.map((violation) => `${path.basename(violation.path)}:${violation.label}`))].sort(),
  };
  if (violations.length > 0) {
    const error = new Error(`privacy scan failed: ${violations.length} violation(s)`);
    error.result = result;
    throw error;
  }
  return result;
}

async function main() {
  try {
    const result = await scanPrivacy(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = error?.result;
    if (result) console.error(JSON.stringify(result));
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { collectPrivateInputNeedles, collectPrivacyNeedles, commonRepositoryRoots, parseArgs, scanPrivacy };
