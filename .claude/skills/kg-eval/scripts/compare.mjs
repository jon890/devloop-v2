#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--baseline" && arg !== "--candidate") {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    args[arg.slice(2)] = value;
    index += 1;
  }
  if (!args.baseline) throw new Error("--baseline is required");
  if (!args.candidate) throw new Error("--candidate is required");
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const VERDICT_RANK = new Map([
  ["FAIL", 0],
  ["REVIEW", 1],
  ["PASS", 2],
]);

function verdictRank(verdict) {
  return VERDICT_RANK.get(verdict) ?? 1;
}

function questionMap(summary) {
  if (!Array.isArray(summary.questions)) {
    throw new Error("summary questions must be an array");
  }
  return new Map(summary.questions.map((question) => [question.id, question]));
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveSuiteHash(summary, role = "summary") {
  const topLevel = nonemptyString(summary?.suiteHash) ? summary.suiteHash : null;
  const nested = nonemptyString(summary?.suite?.hash) ? summary.suite.hash : null;
  if (topLevel && nested && topLevel !== nested) {
    throw new Error(`${role} has conflicting suite hashes: suiteHash=${topLevel} suite.hash=${nested}`);
  }
  const resolved = topLevel ?? nested;
  if (!resolved) {
    throw new Error(`${role} suiteHash is missing`);
  }
  return resolved;
}

function axisChanges(baseline, candidate) {
  const before = new Set(baseline.failedAxes ?? []);
  const after = new Set(candidate.failedAxes ?? []);
  return {
    resolved: [...before].filter((axis) => !after.has(axis)).sort(),
    added: [...after].filter((axis) => !before.has(axis)).sort(),
  };
}

function compareSummaries(baseline, candidate) {
  const baselineHash = resolveSuiteHash(baseline, "baseline");
  const candidateHash = resolveSuiteHash(candidate, "candidate");
  if (baselineHash !== candidateHash) {
    throw new Error(`suiteHash differs: baseline=${baselineHash} candidate=${candidateHash}`);
  }
  const baselineQuestions = questionMap(baseline);
  const candidateQuestions = questionMap(candidate);
  const result = {
    suiteHash: baselineHash,
    improved: [],
    regressed: [],
    unchanged: [],
    review: [],
    axisChanges: [],
    failureBoundaryChanges: [],
  };

  for (const [id, before] of baselineQuestions) {
    const after = candidateQuestions.get(id);
    if (!after) {
      const axes = axisChanges(before, {});
      result.review.push(id);
      if (axes.resolved.length > 0 || axes.added.length > 0) {
        result.axisChanges.push({ id, ...axes });
      }
      result.failureBoundaryChanges.push({ id, from: before.failureBoundary ?? "NONE", to: "MISSING", axes });
      continue;
    }
    const rankBefore = verdictRank(before.finalVerdict);
    const rankAfter = verdictRank(after.finalVerdict);
    if (after.finalVerdict === "REVIEW" || before.finalVerdict === "REVIEW") {
      result.review.push(id);
    } else if (rankAfter > rankBefore) {
      result.improved.push(id);
    } else if (rankAfter < rankBefore) {
      result.regressed.push(id);
    } else {
      result.unchanged.push(id);
    }
    const axes = axisChanges(before, after);
    if (axes.resolved.length > 0 || axes.added.length > 0) {
      result.axisChanges.push({ id, ...axes });
    }
    if ((before.failureBoundary ?? "NONE") !== (after.failureBoundary ?? "NONE")) {
      result.failureBoundaryChanges.push({
        id,
        from: before.failureBoundary ?? "NONE",
        to: after.failureBoundary ?? "NONE",
        axes,
      });
    }
  }

  for (const id of candidateQuestions.keys()) {
    if (!baselineQuestions.has(id)) {
      const axes = axisChanges({}, candidateQuestions.get(id));
      result.review.push(id);
      if (axes.resolved.length > 0 || axes.added.length > 0) {
        result.axisChanges.push({ id, ...axes });
      }
      result.failureBoundaryChanges.push({ id, from: "MISSING", to: candidateQuestions.get(id).failureBoundary ?? "NONE", axes });
    }
  }

  for (const key of ["improved", "regressed", "unchanged", "review"]) {
    result[key].sort();
  }
  result.axisChanges.sort((left, right) => left.id.localeCompare(right.id));
  result.failureBoundaryChanges.sort((left, right) => left.id.localeCompare(right.id));
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = compareSummaries(await readJson(args.baseline), await readJson(args.candidate));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { compareSummaries, parseArgs, resolveSuiteHash };
