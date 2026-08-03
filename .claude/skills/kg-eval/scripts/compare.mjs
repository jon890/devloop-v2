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

/**
 * 같은 문항의 정답 규모가 달라졌는지 본다. 달라졌으면 기준 변경이므로 개선·회귀로 분류할 수 없다.
 * 요약 리포트가 담는 `requiredEvidenceCount`·`supportingEvidenceCount` 로 판정한다.
 */
function goldChanged(before, after) {
  return (
    (before.requiredEvidenceCount ?? null) !== (after.requiredEvidenceCount ?? null) ||
    (before.supportingEvidenceCount ?? null) !== (after.supportingEvidenceCount ?? null)
  );
}

/**
 * 평가 세트는 시간이 지나며 자란다. 세트 해시가 다르다고 비교를 거부하면 문항을 더할 때마다
 * 비교선이 끊기므로, **문항 id 교집합**으로 비교하고 더해진·빠진 문항을 명시한다.
 *
 * 다만 같은 문항의 gold 가 바뀐 경우는 다르다. 그건 기준 변경이라 개선·회귀 판정에 쓸 수 없으므로
 * `criteriaChanged` 로 따로 빼서 숫자에 섞이지 않게 한다.
 */
function compareSummaries(baseline, candidate) {
  const baselineHash = resolveSuiteHash(baseline, "baseline");
  const candidateHash = resolveSuiteHash(candidate, "candidate");
  const baselineQuestions = questionMap(baseline);
  const candidateQuestions = questionMap(candidate);
  const result = {
    baselineSuiteHash: baselineHash,
    candidateSuiteHash: candidateHash,
    suiteChanged: baselineHash !== candidateHash,
    added: [],
    removed: [],
    criteriaChanged: [],
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
      result.removed.push(id);
      continue;
    }
    if (goldChanged(before, after)) {
      result.criteriaChanged.push(id);
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
      result.added.push(id);
    }
  }

  for (const key of ["added", "removed", "criteriaChanged", "improved", "regressed", "unchanged", "review"]) {
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
