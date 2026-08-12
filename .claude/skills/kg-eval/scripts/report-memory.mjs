#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadMemorySuite } from "./memory/suite.mjs";

const REPORT_SCHEMA_VERSION = "memory-utility-report/v1";
const MISS_LOCK_SCHEMA_VERSION = "memory-private-miss-lock/v1";
const CONDITIONS = ["no-memory", "agent-triggered", "oracle-memory"];
const METRICS = ["wallTimeMs", "turns", "toolCalls", "sourceReads", "memoryCalls", "inputTokens", "outputTokens"];
const DELTA_METRICS = ["wrongEditCount", "reworkCount", "sourceReads", "memoryCalls", "wallTimeMs", "turns", "toolCalls", "inputTokens", "outputTokens"];
const FAILURE_BOUNDARIES = new Set(["SOURCE", "MEMORY", "RETRIEVAL", "AGENT", "IMPLEMENTATION", "VALIDATION", "NONE"]);
const FAILURE_BOUNDARY_ORDER = ["SOURCE", "MEMORY", "AGENT", "RETRIEVAL", "IMPLEMENTATION", "VALIDATION", "NONE"];

function usage() {
  return `Usage: node .claude/skills/kg-eval/scripts/report-memory.mjs --run <run.json> --json-out <report.json> --markdown-out <report.md> [options]

Options:
  --suite <suite.json>             Public memory suite. Defaults to run.suitePath.
  --private-miss-lock-out <path>   Private miss lock path. Defaults to eval/runs/plan014-private-miss-lock.json.
`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set(["--run", "--suite", "--json-out", "--markdown-out", "--private-miss-lock-out"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    args[arg.slice(2)] = value;
    index += 1;
  }
  for (const required of ["run", "json-out", "markdown-out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return {
    runPath: args.run,
    suitePath: args.suite,
    jsonOutPath: args["json-out"],
    markdownOutPath: args["markdown-out"],
    privateMissLockOutPath: args["private-miss-lock-out"] ?? "eval/runs/plan014-private-miss-lock.json",
  };
}

async function readJsonOrJsonl(filePath) {
  const text = await readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (jsonError) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 1) return JSON.parse(lines[0]);
    throw jsonError;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortedStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function attemptSort(left, right) {
  return left.taskId.localeCompare(right.taskId) || left.condition.localeCompare(right.condition) || left.repetition - right.repetition;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function metricValue(attempt, metric) {
  return numberOrNull(attempt?.[metric]);
}

function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function retrievalObservations(attempt) {
  return Array.isArray(attempt.retrievalObservations) ? attempt.retrievalObservations : [];
}

function hasUnobservedRetrieval(attempt) {
  return retrievalObservations(attempt).some((observation) => observation?.outcome === "unobserved");
}

function observedSearchOccurred(attempt) {
  return (attempt.agentMemoryCalls ?? attempt.memoryCalls ?? 0) > 0;
}

function completeLexicalMiss(attempt) {
  if (hasUnobservedRetrieval(attempt)) return false;
  return retrievalObservations(attempt).some((observation) => {
    const required = sortedStrings(observation?.requiredMemoryIds);
    const retrieved = new Set(sortedStrings(observation?.retrievedMemoryIds));
    return required.length > 0 && required.every((id) => !retrieved.has(id));
  });
}

function retrievalObservationComplete(attempt) {
  return !hasUnobservedRetrieval(attempt);
}

function explicitSourceFailure(attempt) {
  return Boolean(attempt.sourceFailure || attempt.runHashMismatch || attempt.taskInputMismatch || attempt.generationFailure);
}

function explicitMemoryFailure(attempt) {
  const memoryCalls = attempt.agentMemoryCalls ?? attempt.memoryCalls ?? 0;
  return Boolean(
    attempt.workspaceContamination ||
      attempt.conditionContamination ||
      attempt.requiredOracleFailure ||
      attempt.oracleRequiredFailure ||
      attempt.expectedMemoryMissing ||
      (attempt.condition === "no-memory" && memoryCalls > 0) ||
      (attempt.condition === "oracle-memory" && (attempt.oracleMemoryProvided ?? 0) !== 1),
  );
}

function derivedFailureBoundary(attempt) {
  if (explicitSourceFailure(attempt)) return "SOURCE";
  if (explicitMemoryFailure(attempt)) return "MEMORY";
  if ((attempt.status ?? 0) !== 0 || attempt.timedOut === true || attempt.outputOverflow) return "AGENT";
  if (attempt.condition === "agent-triggered" && attempt.taskSuccess === false && completeLexicalMiss(attempt)) return "RETRIEVAL";
  if ((attempt.wrongEditCount ?? 0) > 0 || (attempt.taskSuccess === false && attempt.validationStatus === 0)) return "IMPLEMENTATION";
  if ((attempt.validationStatus ?? 0) !== 0) return "VALIDATION";
  return "NONE";
}

function failureBoundary(attempt) {
  const candidates = [derivedFailureBoundary(attempt), attempt.failureBoundary].filter((boundary) => FAILURE_BOUNDARIES.has(boundary));
  return candidates.sort((left, right) => FAILURE_BOUNDARY_ORDER.indexOf(left) - FAILURE_BOUNDARY_ORDER.indexOf(right))[0] ?? "NONE";
}

function cleanSuccess(attempt) {
  if (attempt.taskSuccess !== true) return false;
  if ((attempt.wrongEditCount ?? 0) !== 0) return false;
  if (failureBoundary(attempt) !== "NONE") return false;
  if (attempt.condition === "agent-triggered" && hasUnobservedRetrieval(attempt)) return false;
  return true;
}

function cleanFailure(attempt) {
  return attempt.taskSuccess === false && (attempt.wrongEditCount ?? 0) === 0 && failureBoundary(attempt) !== "NONE";
}

function stabilityForAttempts(attempts) {
  const wrongEditCount = sum(attempts.map((attempt) => attempt.wrongEditCount ?? 0));
  const cleanSuccessCount = attempts.filter(cleanSuccess).length;
  const cleanFailures = attempts.filter(cleanFailure);
  const cleanFailureCount = cleanFailures.length;
  const unobservedCount = attempts.filter(hasUnobservedRetrieval).length;
  let status = "UNSTABLE";
  if (wrongEditCount > 0) {
    status = "REGRESSION";
  } else if (attempts.length === 3 && cleanSuccessCount === 3) {
    status = "STABLE_SUCCESS";
  } else if (attempts.length === 3 && cleanFailureCount === 3 && new Set(cleanFailures.map(failureBoundary)).size === 1) {
    status = "STABLE_FAILURE";
  }
  return { status, cleanSuccessCount, cleanFailureCount, wrongEditCount, unobservedCount };
}

function taskSuccessScore(stability) {
  if (stability.status === "STABLE_SUCCESS") return 1;
  if (stability.status === "STABLE_FAILURE") return 0;
  return null;
}

function groupMetricSummary(attempts) {
  const summary = {
    taskSuccess: taskSuccessScore(stabilityForAttempts(attempts)),
    wrongEditCount: sum(attempts.map((attempt) => attempt.wrongEditCount ?? 0)),
    reworkCount: sum(attempts.map((attempt) => attempt.reworkCount ?? 0)),
  };
  for (const metric of METRICS) summary[metric] = median(attempts.map((attempt) => metricValue(attempt, metric)));
  return summary;
}

function deltaRecord(taskId, condition, baselineGroup, candidateGroup) {
  const baselineStable = ["STABLE_SUCCESS", "STABLE_FAILURE"].includes(baselineGroup?.stability?.status);
  const candidateStable = ["STABLE_SUCCESS", "STABLE_FAILURE"].includes(candidateGroup?.stability?.status);
  const record = {
    taskId,
    condition,
    noMemoryStableUnavailable: !baselineStable,
    candidateStableUnavailable: !candidateStable,
    taskSuccessDelta: null,
  };
  for (const metric of DELTA_METRICS) record[`${metric}Delta`] = null;
  if (!baselineStable || !candidateStable) return record;
  const baseline = groupMetricSummary(baselineGroup.attempts);
  const candidate = groupMetricSummary(candidateGroup.attempts);
  record.taskSuccessDelta = candidate.taskSuccess - baseline.taskSuccess;
  for (const metric of DELTA_METRICS) {
    if (baseline[metric] === null || candidate[metric] === null) continue;
    record[`${metric}Delta`] = candidate[metric] - baseline[metric];
  }
  return record;
}

function taxAggregate(groups, condition, stableOnly) {
  const selected = groups.filter((group) => group.condition === condition);
  const unstableAttemptCount = selected
    .filter((group) => !["STABLE_SUCCESS", "STABLE_FAILURE"].includes(group.stability.status))
    .reduce((count, group) => count + group.attempts.length, 0);
  const aggregateGroups = selected.filter((group) => {
    const stable = ["STABLE_SUCCESS", "STABLE_FAILURE"].includes(group.stability.status);
    return stableOnly ? stable : !stable;
  });
  const attempts = aggregateGroups.flatMap((group) => group.attempts);
  const record = {
    condition,
    groupCount: aggregateGroups.length,
    attemptCount: attempts.length,
    unstableCount: unstableAttemptCount,
    wrongEditCount: sum(attempts.map((attempt) => attempt.wrongEditCount ?? 0)),
    reworkCount: sum(attempts.map((attempt) => attempt.reworkCount ?? 0)),
  };
  for (const metric of METRICS) record[`${metric}Median`] = median(attempts.map((attempt) => metricValue(attempt, metric)));
  return record;
}

function triggerClassification(task, attempt) {
  if (attempt.condition !== "agent-triggered") return null;
  if (hasUnobservedRetrieval(attempt)) return "UNOBSERVED";
  const searched = observedSearchOccurred(attempt);
  if (task?.category === "experience-needed") return searched ? "TP" : "FN";
  if (task?.category === "code-only") return searched ? "FP" : "TN";
  return null;
}

function triggerMatrix(tasksById, attempts) {
  const matrix = { TP: 0, FN: 0, FP: 0, TN: 0, unobservedCount: 0, precision: null, recall: null };
  for (const attempt of attempts) {
    const classification = triggerClassification(tasksById.get(attempt.taskId), attempt);
    if (!classification) continue;
    if (classification === "UNOBSERVED") matrix.unobservedCount += 1;
    else matrix[classification] += 1;
  }
  const precisionDenominator = matrix.TP + matrix.FP;
  const recallDenominator = matrix.TP + matrix.FN;
  matrix.precision = precisionDenominator === 0 ? null : matrix.TP / precisionDenominator;
  matrix.recall = recallDenominator === 0 ? null : matrix.TP / recallDenominator;
  return matrix;
}

function publicAttemptDiagnostics(attempt) {
  const boundary = failureBoundary(attempt);
  const clean = cleanSuccess({ ...attempt, failureBoundary: boundary });
  return {
    taskId: attempt.taskId,
    condition: attempt.condition,
    repetition: attempt.repetition,
    triggerOutcome: attempt.triggerOutcome ?? null,
    retrievalObservationComplete: retrievalObservationComplete(attempt),
    lexicalMiss: clean && completeLexicalMiss(attempt),
    failureBoundary: boundary,
  };
}

function privateMissAttempt(attempt) {
  return {
    sourceRunKey: attempt.sourceRunKey ?? `${attempt.taskId}-${attempt.condition}-${attempt.repetition}`,
    taskId: attempt.taskId,
    condition: attempt.condition,
    repetition: attempt.repetition,
    triggerOutcome: attempt.triggerOutcome ?? null,
    query: retrievalObservations(attempt).find((observation) => observation?.query)?.query ?? null,
    topK: retrievalObservations(attempt).find((observation) => Number.isInteger(observation?.topK))?.topK ?? null,
    requiredMemoryIds: sortedStrings(retrievalObservations(attempt).flatMap((observation) => observation?.requiredMemoryIds ?? [])),
    retrievedMemoryIds: sortedStrings(retrievalObservations(attempt).flatMap((observation) => observation?.retrievedMemoryIds ?? [])),
    outcome: hasUnobservedRetrieval(attempt)
      ? "unobserved"
      : retrievalObservations(attempt).some((observation) => observation?.outcome === "hit")
        ? "hit"
        : completeLexicalMiss(attempt)
          ? "miss"
          : "unobserved",
    lexicalMiss: cleanSuccess(attempt) && completeLexicalMiss(attempt),
    failureBoundary: failureBoundary(attempt),
  };
}

function validateCompleteRun(run, suite) {
  if (!Array.isArray(run.attempts)) throw new Error("PHASE_BLOCKED: utility 비교 입력 불완전: attempts missing");
  const repeats = run.executionPlan?.repeats ?? 3;
  const conditions = run.executionPlan?.conditions ?? CONDITIONS;
  const expected = new Set();
  for (const task of suite.tasks) {
    for (const condition of conditions) {
      for (let repetition = 1; repetition <= repeats; repetition += 1) expected.add(`${task.id}:${condition}:${repetition}`);
    }
  }
  const seen = new Set(run.attempts.map((attempt) => `${attempt.taskId}:${attempt.condition}:${attempt.repetition}`));
  const missing = [...expected].filter((key) => !seen.has(key));
  if (missing.length > 0) throw new Error(`PHASE_BLOCKED: utility 비교 입력 불완전: missing ${missing.slice(0, 5).join(", ")}`);
  if (repeats !== 3) throw new Error("PHASE_BLOCKED: utility 비교 입력 불완전: repeats must be 3");
}

function buildMemoryReport({ run, suite }) {
  validateCompleteRun(run, suite);
  const tasksById = new Map(suite.tasks.map((task) => [task.id, task]));
  const attempts = [...run.attempts].sort(attemptSort);
  const groups = [];
  for (const task of suite.tasks) {
    for (const condition of run.executionPlan.conditions) {
      const groupAttempts = attempts.filter((attempt) => attempt.taskId === task.id && attempt.condition === condition).sort(attemptSort);
      const stability = stabilityForAttempts(groupAttempts);
      groups.push({ taskId: task.id, condition, attempts: groupAttempts, stability });
    }
  }
  const stability = groups.map((group) => ({
    taskId: group.taskId,
    condition: group.condition,
    ...group.stability,
    failureBoundary: group.stability.status === "STABLE_FAILURE" ? failureBoundary(group.attempts[0]) : null,
  }));
  const taskLevelDeltas = [];
  for (const task of suite.tasks) {
    const baseline = groups.find((group) => group.taskId === task.id && group.condition === "no-memory");
    for (const condition of ["agent-triggered", "oracle-memory"]) {
      const candidate = groups.find((group) => group.taskId === task.id && group.condition === condition);
      taskLevelDeltas.push(deltaRecord(task.id, condition, baseline, candidate));
    }
  }
  const retrievalTax = {
    stable: CONDITIONS.map((condition) => taxAggregate(groups, condition, true)),
    unstable: CONDITIONS.map((condition) => taxAggregate(groups, condition, false)),
  };
  const privateMissLock = {
    schemaVersion: MISS_LOCK_SCHEMA_VERSION,
    suiteHash: run.suiteHash,
    sourceLockHash: run.sourceLockHash,
    memoryIndexHash: run.memoryIndexHash,
    attempts: attempts.map(privateMissAttempt).sort(attemptSort),
  };
  const privateMissLockHash = sha256Hex(canonicalBytes(privateMissLock));
  const diagnostics = attempts.map(publicAttemptDiagnostics);
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: null,
    suite: {
      suiteId: suite.suiteId,
      title: suite.title,
      project: suite.project,
      hash: run.suiteHash,
      sourceLockHash: run.sourceLockHash,
      memoryIndexHash: run.memoryIndexHash,
    },
    run: {
      agent: run.agent ?? null,
      agentOptions: run.agentOptions ?? null,
      taskCount: suite.tasks.length,
      attemptCount: attempts.length,
      conditions: run.executionPlan.conditions,
      repeats: run.executionPlan.repeats,
    },
    stability,
    memoryBenefit: {
      taskLevelDeltas,
      stableConditionAggregate: retrievalTax.stable,
      unstableConditionAggregate: retrievalTax.unstable,
      rawWrongEditCount: sum(attempts.map((attempt) => attempt.wrongEditCount ?? 0)),
    },
    retrievalTax,
    triggerMatrix: triggerMatrix(tasksById, attempts),
    lexicalMissCount: diagnostics.filter((diagnostic) => diagnostic.lexicalMiss).length,
    retrievalObservationComplete: diagnostics.every((diagnostic) => diagnostic.retrievalObservationComplete),
    privateMissLockHash,
    attemptDiagnostics: diagnostics,
  };
  return { report, privateMissLock };
}

function markdownValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return String(value);
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => markdownValue(row[header])).join(" | ")} |`),
  ].join("\n");
}

function renderMarkdown(report) {
  const hashRows = [
    { Key: "Suite hash", Value: `\`${report.suite.hash}\`` },
    { Key: "Source lock hash", Value: `\`${report.suite.sourceLockHash}\`` },
    { Key: "Memory index hash", Value: `\`${report.suite.memoryIndexHash}\`` },
    { Key: "Private miss lock hash", Value: `\`${report.privateMissLockHash}\`` },
  ];
  const stabilityRows = report.stability.map((item) => ({
    Task: item.taskId,
    Condition: item.condition,
    Status: item.status,
    Success: item.cleanSuccessCount,
    Failure: item.cleanFailureCount,
    Wrong: item.wrongEditCount,
    Unobserved: item.unobservedCount,
    Boundary: item.failureBoundary,
  }));
  const deltaRows = report.memoryBenefit.taskLevelDeltas.map((item) => ({
    Task: item.taskId,
    Condition: item.condition,
    Success: item.taskSuccessDelta,
    Wrong: item.wrongEditCountDelta,
    Rework: item.reworkCountDelta,
    SourceReads: item.sourceReadsDelta,
    MemoryCalls: item.memoryCallsDelta,
    WallMs: item.wallTimeMsDelta,
    Turns: item.turnsDelta,
    Tools: item.toolCallsDelta,
    InputTokens: item.inputTokensDelta,
    OutputTokens: item.outputTokensDelta,
  }));
  const taxRow = (item) => ({
    Condition: item.condition,
    Groups: item.groupCount,
    Attempts: item.attemptCount,
    Unstable: item.unstableCount,
    MemoryCalls: item.memoryCallsMedian,
    SourceReads: item.sourceReadsMedian,
    Turns: item.turnsMedian,
    Tools: item.toolCallsMedian,
    WallMs: item.wallTimeMsMedian,
    InputTokens: item.inputTokensMedian,
    OutputTokens: item.outputTokensMedian,
  });
  const stableTaxRows = report.retrievalTax.stable.map(taxRow);
  const unstableTaxRows = report.retrievalTax.unstable.map(taxRow);
  const trigger = report.triggerMatrix;
  return `${[
    `# ${report.suite.title} Memory Utility Report`,
    "",
    "## Goal",
    "",
    "Memory Benefit, Retrieval Tax, trigger quality, and failure boundaries are separated so the benchmark does not hide regressions behind aggregate success.",
    "",
    "## Hashes",
    "",
    markdownTable(["Key", "Value"], hashRows),
    "",
    "## Stability",
    "",
    markdownTable(["Task", "Condition", "Status", "Success", "Failure", "Wrong", "Unobserved", "Boundary"], stabilityRows),
    "",
    "## Memory Benefit",
    "",
    markdownTable(
      ["Task", "Condition", "Success", "Wrong", "Rework", "SourceReads", "MemoryCalls", "WallMs", "Turns", "Tools", "InputTokens", "OutputTokens"],
      deltaRows,
    ),
    "",
    "## Stable Retrieval Tax",
    "",
    markdownTable(["Condition", "Groups", "Attempts", "Unstable", "MemoryCalls", "SourceReads", "Turns", "Tools", "WallMs", "InputTokens", "OutputTokens"], stableTaxRows),
    "",
    "## Unstable Retrieval Tax",
    "",
    markdownTable(["Condition", "Groups", "Attempts", "Unstable", "MemoryCalls", "SourceReads", "Turns", "Tools", "WallMs", "InputTokens", "OutputTokens"], unstableTaxRows),
    "",
    "## Trigger Matrix",
    "",
    markdownTable(["TP", "FN", "FP", "TN", "Unobserved", "Precision", "Recall"], [
      {
        TP: trigger.TP,
        FN: trigger.FN,
        FP: trigger.FP,
        TN: trigger.TN,
        Unobserved: trigger.unobservedCount,
        Precision: trigger.precision,
        Recall: trigger.recall,
      },
    ]),
    "",
    "## Failure Boundary",
    "",
    `Lexical miss count: ${report.lexicalMissCount}`,
    "",
    `Retrieval observation complete: ${report.retrievalObservationComplete}`,
    "",
  ].join("\n")}`;
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const run = await readJsonOrJsonl(options.runPath);
    const suitePath = options.suitePath ?? run.suitePath;
    if (!suitePath) throw new Error("--suite is required when run.suitePath is missing");
    const loadedSuite = await loadMemorySuite(suitePath);
    if (loadedSuite.errors.length > 0) throw new Error(`memory suite validation failed:\n${loadedSuite.errors.join("\n")}`);
    if (run.suiteHash && loadedSuite.hash !== run.suiteHash) throw new Error("PHASE_BLOCKED: utility 비교 입력 불완전: suite hash mismatch");
    const { report, privateMissLock } = buildMemoryReport({ run, suite: loadedSuite.suite });
    const privateMissLockText = canonicalBytes(privateMissLock);
    await writeText(options.privateMissLockOutPath, privateMissLockText);
    await writeText(options.jsonOutPath, canonicalBytes(report));
    await writeText(options.markdownOutPath, renderMarkdown(report));
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: report.schemaVersion,
        attemptCount: report.run.attemptCount,
        privateMissLockHash: report.privateMissLockHash,
        retrievalObservationComplete: report.retrievalObservationComplete,
      })}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export {
  buildMemoryReport,
  canonicalBytes,
  completeLexicalMiss,
  derivedFailureBoundary,
  failureBoundary,
  parseArgs,
  renderMarkdown,
  stabilityForAttempts,
};
