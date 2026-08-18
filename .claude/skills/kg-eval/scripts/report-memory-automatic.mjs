#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadSourceLock, validateSuiteSourceLockPair } from "./memory/source-lock.mjs";
import { loadMemorySuite } from "./memory/suite.mjs";

const REPORT_SCHEMA_VERSION = "memory-automatic-report/v1";
const REPORT_DATE = "2026-08-12";
const VOLUNTARY_CONDITION = "agent-triggered";
const AUTOMATIC_CONDITION = "automatic";
const COST_METRICS = ["wallTimeMs", "inputTokens", "outputTokens"];
const SUMMARY_METRICS = ["wallTimeMs", "inputTokens", "outputTokens", "memoryCalls", "contextBytes", "sourceReads"];

function usage() {
  return `Usage: node .claude/skills/kg-eval/scripts/report-memory-automatic.mjs --voluntary <plan014.json> --automatic <plan017.json> --json-out <report.json> --markdown-out <report.md>\n`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set(["--voluntary", "--automatic", "--json-out", "--markdown-out"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  for (const required of ["voluntary", "automatic", "json-out", "markdown-out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return {
    voluntaryPath: args.voluntary,
    automaticPath: args.automatic,
    jsonOutPath: args["json-out"],
    markdownOutPath: args["markdown-out"],
  };
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

async function readJsonWithBytes(filePath) {
  const bytes = await readFile(filePath, "utf8");
  return { bytes, value: JSON.parse(bytes) };
}

function attemptKey(attempt) {
  return `${attempt.taskId}:${attempt.repetition}`;
}

function compareValues(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function ratioDelta(candidate, baseline) {
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (candidate - baseline) / baseline;
}

function successCount(attempts) {
  return attempts.filter((attempt) => attempt.taskSuccess === true).length;
}

function wrongEditCount(attempts) {
  return sum(attempts.map((attempt) => attempt.wrongEditCount ?? 0));
}

function taskInputById(run) {
  return new Map((run.taskInputs ?? []).map((input) => [input.taskId, input]));
}

function attemptsForCondition(run, condition) {
  return (run.attempts ?? [])
    .filter((attempt) => attempt.condition === condition)
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.repetition - right.repetition);
}

function groupByTask(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    if (!groups.has(attempt.taskId)) groups.set(attempt.taskId, []);
    groups.get(attempt.taskId).push(attempt);
  }
  for (const group of groups.values()) group.sort((left, right) => left.repetition - right.repetition);
  return groups;
}

function validateRunShape({ voluntaryRun, automaticRun, voluntaryAttempts, automaticAttempts, suite, sourceLock }) {
  if (voluntaryAttempts.length !== 12) throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: expected 12 voluntary attempts, received ${voluntaryAttempts.length}`);
  if (automaticAttempts.length !== 12) throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: expected 12 automatic attempts, received ${automaticAttempts.length}`);
  if (voluntaryRun.suiteHash !== automaticRun.suiteHash || voluntaryRun.suiteHash !== suite.hash) {
    throw new Error("PHASE_BLOCKED: automatic 비교 입력 불완전: suite hash mismatch");
  }
  if (voluntaryRun.sourceLockHash !== automaticRun.sourceLockHash || voluntaryRun.sourceLockHash !== sourceLock.hash) {
    throw new Error("PHASE_BLOCKED: automatic 비교 입력 불완전: source lock hash mismatch");
  }
  if (voluntaryRun.memoryIndexHash !== automaticRun.memoryIndexHash) {
    throw new Error("PHASE_BLOCKED: automatic 비교 입력 불완전: memory index hash mismatch");
  }
  const expectedKeys = new Set(suite.suite.tasks.flatMap((task) => [1, 2, 3].map((repetition) => `${task.id}:${repetition}`)));
  for (const [label, attempts] of [
    ["voluntary", voluntaryAttempts],
    ["automatic", automaticAttempts],
  ]) {
    const seen = new Set();
    for (const attempt of attempts) {
      const key = attemptKey(attempt);
      if (!expectedKeys.has(key)) throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: unexpected ${label} ${key}`);
      if (seen.has(key)) throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: duplicate ${label} ${key}`);
      seen.add(key);
    }
    const missing = [...expectedKeys].filter((key) => !seen.has(key));
    if (missing.length > 0) throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: missing ${label} ${missing.slice(0, 5).join(", ")}`);
  }
}

function validateIdentity({ voluntaryRun, automaticRun, voluntaryAttempts, automaticAttempts }) {
  const expectedTopLevel = {
    agent: "codex",
    agentOptions: { model: "gpt-5.6-luna", effort: "low", permissionMode: "workspace-write" },
  };
  const topLevelChecks = [
    ["agent", voluntaryRun.agent, automaticRun.agent, expectedTopLevel.agent],
    ["agentOptions.model", voluntaryRun.agentOptions?.model, automaticRun.agentOptions?.model, expectedTopLevel.agentOptions.model],
    ["agentOptions.effort", voluntaryRun.agentOptions?.effort, automaticRun.agentOptions?.effort, expectedTopLevel.agentOptions.effort],
    ["agentOptions.permissionMode", voluntaryRun.agentOptions?.permissionMode, automaticRun.agentOptions?.permissionMode, expectedTopLevel.agentOptions.permissionMode],
  ];
  const topLevelMismatches = topLevelChecks
    .filter(([, left, right, expected]) => !compareValues(left, right) || !compareValues(left, expected))
    .map(([field]) => field);
  if (topLevelMismatches.length > 0) {
    throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: run identity mismatch ${topLevelMismatches.slice(0, 5).join(", ")}`);
  }
  const voluntaryInputs = taskInputById(voluntaryRun);
  const automaticInputs = taskInputById(automaticRun);
  const automaticByKey = new Map(automaticAttempts.map((attempt) => [attemptKey(attempt), attempt]));
  const mismatches = [];
  for (const voluntary of voluntaryAttempts) {
    const automatic = automaticByKey.get(attemptKey(voluntary));
    const voluntaryInput = voluntaryInputs.get(voluntary.taskId);
    const automaticInput = automaticInputs.get(voluntary.taskId);
    const agent = {
      left: voluntary.agent ?? voluntaryRun.agent,
      right: automatic?.agent ?? automaticRun.agent,
      expected: expectedTopLevel.agent,
    };
    const model = {
      left: voluntary.agentOptions?.model ?? voluntaryRun.agentOptions?.model,
      right: automatic?.agentOptions?.model ?? automaticRun.agentOptions?.model,
      expected: expectedTopLevel.agentOptions.model,
    };
    const effort = {
      left: voluntary.agentOptions?.effort ?? voluntaryRun.agentOptions?.effort,
      right: automatic?.agentOptions?.effort ?? automaticRun.agentOptions?.effort,
      expected: expectedTopLevel.agentOptions.effort,
    };
    const permissionMode = {
      left: voluntary.agentOptions?.permissionMode ?? voluntaryRun.agentOptions?.permissionMode,
      right: automatic?.agentOptions?.permissionMode ?? automaticRun.agentOptions?.permissionMode,
      expected: expectedTopLevel.agentOptions.permissionMode,
    };
    const pairedChecks = [
      ["baseRevision", voluntaryInput?.baseRevision, automaticInput?.baseRevision],
      ["validationCommand", voluntaryInput?.validationCommand, automaticInput?.validationCommand],
      ["agent", agent.left, agent.right],
      ["model", model.left, model.right],
      ["effort", effort.left, effort.right],
      ["permissionMode", permissionMode.left, permissionMode.right],
    ];
    for (const [field, left, right] of pairedChecks) {
      if (!compareValues(left, right)) mismatches.push({ key: attemptKey(voluntary), field });
    }
    for (const [field, values] of [
      ["agent", agent],
      ["model", model],
      ["effort", effort],
      ["permissionMode", permissionMode],
    ]) {
      if (!compareValues(values.left, values.expected) || !compareValues(values.right, values.expected)) {
        mismatches.push({ key: attemptKey(voluntary), field: `${field}.expected` });
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`PHASE_BLOCKED: automatic 비교 입력 불완전: identity mismatch ${mismatches.slice(0, 5).map((item) => `${item.key}.${item.field}`).join(", ")}`);
  }
  return {
    comparedAttempts: voluntaryAttempts.length + automaticAttempts.length,
    matchedPairs: voluntaryAttempts.length,
    taskRepetitionValidationModelIndex: true,
  };
}

function retrievalObservations(attempt) {
  return Array.isArray(attempt.retrievalObservations) ? attempt.retrievalObservations : [];
}

function hasVoluntaryMissEvidence(attempt) {
  return attempt.triggerOutcome === "missed_search" || retrievalObservations(attempt).some((observation) => observation?.outcome === "miss");
}

function searched(attempt) {
  return (attempt.memoryCalls ?? 0) > 0 || (attempt.agentMemoryCalls ?? 0) > 0;
}

function automaticEmptyRetrieval(attempt) {
  return searched(attempt) && (attempt.retrievedCount ?? 0) === 0 && (attempt.injectedCount ?? 0) === 0 && (attempt.warnedCount ?? 0) === 0 && (attempt.skippedStaleCount ?? 0) === 0;
}

function taskMedianSummary(taskId, category, voluntaryAttempts, automaticAttempts) {
  const summary = {
    taskId,
    category,
    voluntarySuccessCount: successCount(voluntaryAttempts),
    automaticSuccessCount: successCount(automaticAttempts),
    voluntaryWrongEditCount: wrongEditCount(voluntaryAttempts),
    automaticWrongEditCount: wrongEditCount(automaticAttempts),
    metrics: {},
  };
  for (const metric of SUMMARY_METRICS) {
    const voluntaryMedian = median(voluntaryAttempts.map((attempt) => numberOrNull(attempt[metric])));
    const automaticMedian = median(automaticAttempts.map((attempt) => numberOrNull(attempt[metric])));
    summary.metrics[metric] = {
      voluntaryMedian,
      automaticMedian,
      delta: Number.isFinite(voluntaryMedian) && Number.isFinite(automaticMedian) ? automaticMedian - voluntaryMedian : null,
      deltaRatio: ratioDelta(automaticMedian, voluntaryMedian),
      voluntarySampleCount: voluntaryAttempts.filter((attempt) => Number.isFinite(attempt[metric])).length,
      automaticSampleCount: automaticAttempts.filter((attempt) => Number.isFinite(attempt[metric])).length,
    };
  }
  return summary;
}

function triggerMatrix(tasksById, attempts) {
  const matrix = { TP: 0, FN: 0, FP: 0, TN: 0, precision: null, recall: null };
  for (const attempt of attempts) {
    const category = tasksById.get(attempt.taskId)?.category;
    if (category === "experience-needed") {
      if (searched(attempt)) matrix.TP += 1;
      else matrix.FN += 1;
    } else if (category === "code-only") {
      if (searched(attempt)) matrix.FP += 1;
      else matrix.TN += 1;
    }
  }
  const precisionDenominator = matrix.TP + matrix.FP;
  const recallDenominator = matrix.TP + matrix.FN;
  matrix.precision = precisionDenominator === 0 ? null : matrix.TP / precisionDenominator;
  matrix.recall = recallDenominator === 0 ? null : matrix.TP / recallDenominator;
  return matrix;
}

function classifyTasks({ suite, voluntaryGroups, automaticGroups }) {
  const tasksById = new Map(suite.suite.tasks.map((task) => [task.id, task]));
  const recoveredTasks = [];
  const taskSummaries = [];
  const taskRegressions = [];
  for (const task of suite.suite.tasks) {
    const voluntary = voluntaryGroups.get(task.id) ?? [];
    const automatic = automaticGroups.get(task.id) ?? [];
    const voluntaryMissEvidenceCount = voluntary.filter(hasVoluntaryMissEvidence).length;
    const automaticCleanSuccessCount = automatic.filter((attempt) => attempt.taskSuccess === true && (attempt.wrongEditCount ?? 0) === 0).length;
    if (task.category === "experience-needed" && voluntaryMissEvidenceCount > 0 && successCount(voluntary) < 3 && automatic.length === 3 && automaticCleanSuccessCount === 3) {
      recoveredTasks.push({
        taskId: task.id,
        voluntarySuccessCount: successCount(voluntary),
        voluntaryMissEvidenceCount,
        automaticSuccessCount: successCount(automatic),
        automaticWrongEditCount: wrongEditCount(automatic),
      });
    }
    if (successCount(automatic) < successCount(voluntary)) {
      taskRegressions.push({ taskId: task.id, voluntarySuccessCount: successCount(voluntary), automaticSuccessCount: successCount(automatic) });
    }
    taskSummaries.push(taskMedianSummary(task.id, task.category, voluntary, automatic));
  }
  return { tasksById, recoveredTasks, taskSummaries, taskRegressions };
}

function classifyUnnecessary({ automaticAttempts, tasksById }) {
  const codeOnly = automaticAttempts.filter((attempt) => tasksById.get(attempt.taskId)?.category === "code-only" && searched(attempt)).map(attemptKey);
  const empty = automaticAttempts.filter(automaticEmptyRetrieval).map(attemptKey);
  return {
    codeOnlyAttemptKeys: [...new Set(codeOnly)].sort(),
    emptyRetrievalAttemptKeys: [...new Set(empty)].sort(),
    unionAttemptKeys: [...new Set([...codeOnly, ...empty])].sort(),
  };
}

function automaticIntegrity(automaticAttempts) {
  return {
    staleInjectionCount: sum(automaticAttempts.map((attempt) => attempt.staleInjectionCount ?? 0)),
    retrievedBucketMismatchCount: automaticAttempts.filter((attempt) => (attempt.retrievedCount ?? 0) !== (attempt.injectedCount ?? 0) + (attempt.warnedCount ?? 0) + (attempt.skippedStaleCount ?? 0)).length,
    memoryCallMismatchCount: automaticAttempts.filter((attempt) => attempt.memoryCalls !== 1).length,
  };
}

function costDecisionInput(taskSummaries) {
  const rows = taskSummaries.map((task) => {
    const metrics = {};
    for (const metric of COST_METRICS) {
      const item = task.metrics[metric];
      const requiredSamples = metric === "inputTokens" || metric === "outputTokens" ? 3 : 1;
      metrics[metric] = {
        voluntaryMedian: item.voluntaryMedian,
        automaticMedian: item.automaticMedian,
        deltaRatio: item.deltaRatio,
        sampleComplete: item.voluntarySampleCount >= requiredSamples && item.automaticSampleCount >= requiredSamples,
        within25Percent: item.deltaRatio !== null && item.deltaRatio <= 0.25,
      };
    }
    return { taskId: task.taskId, metrics };
  });
  const missing = rows.flatMap((row) => COST_METRICS.filter((metric) => !row.metrics[metric].sampleComplete || row.metrics[metric].deltaRatio === null).map((metric) => `${row.taskId}.${metric}`));
  const overLimit = rows.flatMap((row) => COST_METRICS.filter((metric) => row.metrics[metric].deltaRatio !== null && row.metrics[metric].deltaRatio > 0.25).map((metric) => `${row.taskId}.${metric}`));
  return { rows, missing, overLimit };
}

function decide({ recoveredTasks, unnecessary, integrity, voluntaryAttempts, automaticAttempts, taskRegressions, cost }) {
  const automaticWrong = wrongEditCount(automaticAttempts);
  const voluntaryWrong = wrongEditCount(voluntaryAttempts);
  if (integrity.staleInjectionCount > 0 || automaticWrong > voluntaryWrong || taskRegressions.length > 0) {
    return { decision: "REJECT_AUTOMATIC", priority: 1, reason: "stale injection, wrong edit increase, or task success regression" };
  }
  if (recoveredTasks.length === 0 && unnecessary.unionAttemptKeys.length > 0) {
    return { decision: "REJECT_AUTOMATIC", priority: 2, reason: "no recovered task with unnecessary retrieval attempts" };
  }
  if (recoveredTasks.length >= 1 && cost.missing.length === 0 && cost.overLimit.length === 0) {
    return { decision: "ADOPT_CANDIDATE", priority: 3, reason: "recovered task with no regression and all task-level median cost deltas within 25%" };
  }
  if (recoveredTasks.length >= 1 && cost.overLimit.length > 0) {
    return { decision: "REJECT_AUTOMATIC", priority: 4, reason: "recovered task but at least one task-level median cost delta exceeds 25%" };
  }
  return { decision: "INCONCLUSIVE", priority: 5, reason: "missing token/cost samples or mixed results prevent deterministic adoption" };
}

function aggregateMetrics(attempts) {
  const result = {
    taskSuccessCount: successCount(attempts),
    wrongEditCount: wrongEditCount(attempts),
  };
  for (const metric of SUMMARY_METRICS) {
    result[`${metric}Median`] = median(attempts.map((attempt) => numberOrNull(attempt[metric])));
  }
  return result;
}

async function buildAutomaticReport({ voluntaryRun, automaticRun, voluntaryBytes, automaticBytes }) {
  const loadedSuite = await loadMemorySuite(voluntaryRun.suitePath ?? automaticRun.suitePath);
  if (loadedSuite.errors.length > 0) throw new Error(`memory suite validation failed:\n${loadedSuite.errors.join("\n")}`);
  const sourceLockPath = voluntaryRun.sourceLockPath ?? automaticRun.sourceLockPath;
  if (!sourceLockPath || sourceLockPath !== automaticRun.sourceLockPath) {
    throw new Error("PHASE_BLOCKED: automatic 비교 입력 불완전: source lock path mismatch");
  }
  const loadedSourceLock = await loadSourceLock(sourceLockPath);
  if (loadedSourceLock.errors.length > 0) throw new Error(`source lock validation failed:\n${loadedSourceLock.errors.join("\n")}`);
  const pairErrors = validateSuiteSourceLockPair(loadedSuite.suite, loadedSourceLock.sourceLock);
  if (pairErrors.length > 0) throw new Error(`source lock pair validation failed:\n${pairErrors.join("\n")}`);
  const voluntaryAttempts = attemptsForCondition(voluntaryRun, VOLUNTARY_CONDITION);
  const automaticAttempts = attemptsForCondition(automaticRun, AUTOMATIC_CONDITION);
  validateRunShape({ voluntaryRun, automaticRun, voluntaryAttempts, automaticAttempts, suite: loadedSuite, sourceLock: loadedSourceLock });
  const identity = validateIdentity({ voluntaryRun, automaticRun, voluntaryAttempts, automaticAttempts });
  const voluntaryGroups = groupByTask(voluntaryAttempts);
  const automaticGroups = groupByTask(automaticAttempts);
  const classified = classifyTasks({ suite: loadedSuite, voluntaryGroups, automaticGroups });
  const unnecessary = classifyUnnecessary({ automaticAttempts, tasksById: classified.tasksById });
  const integrity = automaticIntegrity(automaticAttempts);
  if (integrity.memoryCallMismatchCount > 0 || integrity.retrievedBucketMismatchCount > 0) {
    throw new Error(
      `PHASE_BLOCKED: automatic raw 무결성 불일치: memoryCallMismatch=${integrity.memoryCallMismatchCount}, retrievedBucketMismatch=${integrity.retrievedBucketMismatchCount}`,
    );
  }
  const cost = costDecisionInput(classified.taskSummaries);
  const decision = decide({
    recoveredTasks: classified.recoveredTasks,
    unnecessary,
    integrity,
    voluntaryAttempts,
    automaticAttempts,
    taskRegressions: classified.taskRegressions,
    cost,
  });
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportDate: REPORT_DATE,
    generatedAt: null,
    source: {
      voluntaryRunHash: sha256Hex(voluntaryBytes),
      automaticRunHash: sha256Hex(automaticBytes),
      suiteHash: voluntaryRun.suiteHash,
      sourceLockHash: voluntaryRun.sourceLockHash,
      memoryIndexHash: voluntaryRun.memoryIndexHash,
    },
    identity,
    decision,
    counts: {
      voluntaryAttemptCount: voluntaryAttempts.length,
      automaticAttemptCount: automaticAttempts.length,
      recoveredTaskCount: classified.recoveredTasks.length,
      unnecessaryCodeOnlyAttemptCount: unnecessary.codeOnlyAttemptKeys.length,
      emptyRetrievalAttemptCount: unnecessary.emptyRetrievalAttemptKeys.length,
      unnecessaryRetrievalAttemptCount: unnecessary.unionAttemptKeys.length,
      staleInjectionCount: integrity.staleInjectionCount,
      automaticWrongEditCount: wrongEditCount(automaticAttempts),
      voluntaryWrongEditCount: wrongEditCount(voluntaryAttempts),
      taskSuccessRegressionCount: classified.taskRegressions.length,
    },
    trigger: {
      voluntary: triggerMatrix(classified.tasksById, voluntaryAttempts),
      automatic: triggerMatrix(classified.tasksById, automaticAttempts),
    },
    aggregateMetrics: {
      voluntary: aggregateMetrics(voluntaryAttempts),
      automatic: aggregateMetrics(automaticAttempts),
    },
    automaticIntegrity: integrity,
    recoveredTasks: classified.recoveredTasks,
    unnecessaryRetrieval: {
      codeOnlyAttemptKeys: unnecessary.codeOnlyAttemptKeys,
      emptyRetrievalAttemptKeys: unnecessary.emptyRetrievalAttemptKeys,
      unionAttemptKeys: unnecessary.unionAttemptKeys,
    },
    taskRegressions: classified.taskRegressions,
    taskMetrics: classified.taskSummaries,
    costDecisionInput: cost,
  };
}

function markdownValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  if (typeof value === "boolean") return String(value);
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
  const summaryRows = [
    {
      Decision: report.decision.decision,
      Priority: report.decision.priority,
      Recovered: report.counts.recoveredTaskCount,
      Unnecessary: report.counts.unnecessaryRetrievalAttemptCount,
      Stale: report.counts.staleInjectionCount,
      WrongDelta: report.counts.automaticWrongEditCount - report.counts.voluntaryWrongEditCount,
      Regression: report.counts.taskSuccessRegressionCount,
    },
  ];
  const triggerRow = (condition, trigger) => ({
    Condition: condition,
    TP: trigger.TP,
    FN: trigger.FN,
    FP: trigger.FP,
    TN: trigger.TN,
    Precision: trigger.precision,
    Recall: trigger.recall,
  });
  const triggerRows = [triggerRow("voluntary", report.trigger.voluntary), triggerRow("automatic", report.trigger.automatic)];
  const recoveryRows = report.recoveredTasks.map((task) => ({
    Task: task.taskId,
    VoluntarySuccess: task.voluntarySuccessCount,
    MissEvidence: task.voluntaryMissEvidenceCount,
    AutomaticSuccess: task.automaticSuccessCount,
    AutomaticWrong: task.automaticWrongEditCount,
  }));
  const unnecessaryRows = [
    {
      CodeOnly: report.counts.unnecessaryCodeOnlyAttemptCount,
      Empty: report.counts.emptyRetrievalAttemptCount,
      Union: report.counts.unnecessaryRetrievalAttemptCount,
    },
  ];
  const metricRows = report.taskMetrics.map((task) => ({
    Task: task.taskId,
    Category: task.category,
    VSuccess: task.voluntarySuccessCount,
    ASuccess: task.automaticSuccessCount,
    VWrong: task.voluntaryWrongEditCount,
    AWrong: task.automaticWrongEditCount,
    WallDeltaRatio: task.metrics.wallTimeMs.deltaRatio,
    InputDeltaRatio: task.metrics.inputTokens.deltaRatio,
    OutputDeltaRatio: task.metrics.outputTokens.deltaRatio,
    MemoryCallsDelta: task.metrics.memoryCalls.delta,
    ContextBytesAutomatic: task.metrics.contextBytes.automaticMedian,
    SourceReadsDelta: task.metrics.sourceReads.delta,
  }));
  const hashRows = [
    { Key: "Voluntary run hash", Value: `\`${report.source.voluntaryRunHash}\`` },
    { Key: "Automatic run hash", Value: `\`${report.source.automaticRunHash}\`` },
    { Key: "Suite hash", Value: `\`${report.source.suiteHash}\`` },
    { Key: "Source lock hash", Value: `\`${report.source.sourceLockHash}\`` },
    { Key: "Memory index hash", Value: `\`${report.source.memoryIndexHash}\`` },
  ];
  return `${[
    "# Plan017 Memory Automatic Report",
    "",
    "## Summary",
    "",
    markdownTable(["Decision", "Priority", "Recovered", "Unnecessary", "Stale", "WrongDelta", "Regression"], summaryRows),
    "",
    report.decision.reason,
    "",
    "## Hashes",
    "",
    markdownTable(["Key", "Value"], hashRows),
    "",
    "## Identity",
    "",
    markdownTable(["ComparedAttempts", "MatchedPairs", "TaskRevisionValidationModelIndex"], [
      {
        ComparedAttempts: report.identity.comparedAttempts,
        MatchedPairs: report.identity.matchedPairs,
        TaskRevisionValidationModelIndex: report.identity.taskRepetitionValidationModelIndex,
      },
    ]),
    "",
    "## Trigger Quality",
    "",
    markdownTable(["Condition", "TP", "FN", "FP", "TN", "Precision", "Recall"], triggerRows),
    "",
    "## Recovery",
    "",
    recoveryRows.length > 0 ? markdownTable(["Task", "VoluntarySuccess", "MissEvidence", "AutomaticSuccess", "AutomaticWrong"], recoveryRows) : "No recovered tasks.",
    "",
    "## Unnecessary Retrieval",
    "",
    markdownTable(["CodeOnly", "Empty", "Union"], unnecessaryRows),
    "",
    "## Task Metrics",
    "",
    markdownTable(
      ["Task", "Category", "VSuccess", "ASuccess", "VWrong", "AWrong", "WallDeltaRatio", "InputDeltaRatio", "OutputDeltaRatio", "MemoryCallsDelta", "ContextBytesAutomatic", "SourceReadsDelta"],
      metricRows,
    ),
    "",
    "## Public Safety",
    "",
    "The public report contains only hashes, aggregates, task ids, attempt keys, and classifications.",
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
    const voluntary = await readJsonWithBytes(options.voluntaryPath);
    const automatic = await readJsonWithBytes(options.automaticPath);
    const report = await buildAutomaticReport({
      voluntaryRun: voluntary.value,
      automaticRun: automatic.value,
      voluntaryBytes: voluntary.bytes,
      automaticBytes: automatic.bytes,
    });
    await writeText(options.jsonOutPath, canonicalBytes(report));
    await writeText(options.markdownOutPath, renderMarkdown(report));
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: report.schemaVersion,
        decision: report.decision.decision,
        recoveredTaskCount: report.counts.recoveredTaskCount,
        unnecessaryRetrievalAttemptCount: report.counts.unnecessaryRetrievalAttemptCount,
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

export { buildAutomaticReport, canonicalBytes, decide, parseArgs, renderMarkdown };
