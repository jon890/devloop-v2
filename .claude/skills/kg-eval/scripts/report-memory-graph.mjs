#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPORT_SCHEMA_VERSION = "memory-graph-report/v1";
const TASKS = [
  { taskId: "MEM-EXP-001", taskType: "relationship-heavy" },
  { taskId: "MEM-EXP-002", taskType: "general" },
];
const BASELINE_CONDITIONS = ["no-memory", "oracle-memory"];
const GRAPH_CONDITION = "memory-graph";

function usage() {
  return `Usage: node .claude/skills/kg-eval/scripts/report-memory-graph.mjs --baseline <plan014.json> --graph-run <plan016.json> --graph-lock <lock.json> --json-out <report.json> --markdown-out <report.md>\n`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set(["--baseline", "--graph-run", "--graph-lock", "--json-out", "--markdown-out"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    args[arg.slice(2)] = value;
    index += 1;
  }
  for (const required of ["baseline", "graph-run", "graph-lock", "json-out", "markdown-out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return {
    baselinePath: args.baseline,
    graphRunPath: args["graph-run"],
    graphLockPath: args["graph-lock"],
    jsonOutPath: args["json-out"],
    markdownOutPath: args["markdown-out"],
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
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

function attemptsFor(run, taskId, condition) {
  return (run.attempts ?? [])
    .filter((attempt) => attempt.taskId === taskId && attempt.condition === condition)
    .sort((left, right) => left.repetition - right.repetition);
}

function assertThreeAttempts(run, taskId, condition) {
  const attempts = attemptsFor(run, taskId, condition);
  if (attempts.length !== 3) throw new Error(`${taskId}:${condition}: expected exactly 3 attempts`);
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    if (!attempts.some((attempt) => attempt.repetition === repetition)) {
      throw new Error(`${taskId}:${condition}:${repetition}: missing attempt`);
    }
  }
  return attempts;
}

function taskInputById(run) {
  return new Map((run.taskInputs ?? []).map((input) => [input.taskId, input]));
}

function assertSameTaskInputs(baseline, graphRun, taskId) {
  const baselineInput = taskInputById(baseline).get(taskId);
  const graphInput = taskInputById(graphRun).get(taskId);
  if (!baselineInput || !graphInput) throw new Error(`${taskId}: missing task input`);
  for (const field of ["baseRevision", "validationCommand"]) {
    if (JSON.stringify(baselineInput[field]) !== JSON.stringify(graphInput[field])) {
      throw new Error(`${taskId}: task input ${field} differs`);
    }
  }
}

function validateInputs({ baseline, graphRun, graphLock, graphLockFileHash }) {
  if (baseline.suiteHash !== graphRun.suiteHash) throw new Error("suiteHash differs");
  if (baseline.sourceLockHash !== graphRun.sourceLockHash) throw new Error("sourceLockHash differs");
  if (baseline.memoryIndexHash !== graphRun.memoryIndexHash) throw new Error("memoryIndexHash differs");
  if (baseline.agent !== graphRun.agent) throw new Error("agent differs");
  if (JSON.stringify(baseline.agentOptions) !== JSON.stringify(graphRun.agentOptions)) throw new Error("agentOptions differ");
  if (graphRun.graphLockHash !== graphLockFileHash) throw new Error("graphLockHash differs");
  for (const task of TASKS) {
    assertSameTaskInputs(baseline, graphRun, task.taskId);
    for (const condition of BASELINE_CONDITIONS) assertThreeAttempts(baseline, task.taskId, condition);
    assertThreeAttempts(graphRun, task.taskId, GRAPH_CONDITION);
  }
}

function count(attempts, predicate) {
  return attempts.filter(predicate).length;
}

function sum(attempts, field) {
  return attempts.reduce((total, attempt) => total + (Number.isFinite(attempt[field]) ? attempt[field] : 0), 0);
}

function average(attempts, field) {
  const values = attempts.map((attempt) => attempt[field]).filter(Number.isFinite);
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function summarizeAttempts(attempts) {
  return {
    attempts: attempts.length,
    taskSuccess: count(attempts, (attempt) => attempt.taskSuccess === true),
    validationSuccess: count(attempts, (attempt) => attempt.validationStatus === 0),
    wrongEditCount: sum(attempts, "wrongEditCount"),
    wallTimeMsAverage: average(attempts, "wallTimeMs"),
    turnsAverage: average(attempts, "turns"),
    toolCallsAverage: average(attempts, "toolCalls"),
    sourceReadsAverage: average(attempts, "sourceReads"),
    memoryCallsAverage: average(attempts, "memoryCalls"),
    graphCallsAverage: average(attempts, "graphCalls"),
    graphLatencyMsAverage: average(attempts, "graphLatencyMs"),
  };
}

function graphEvidenceSummary(attempts) {
  return {
    trueCount: count(attempts, (attempt) => attempt.graphEvidenceUsed === true),
    falseCount: count(attempts, (attempt) => attempt.graphEvidenceUsed === false),
    nullCount: count(attempts, (attempt) => attempt.graphEvidenceUsed === null),
    graphLlmCalls: sum(attempts, "graphLlmCalls"),
    agentGraphCalls: sum(attempts, "agentGraphCalls"),
  };
}

function verdict({ oracleSummary, graphSummary, evidence }) {
  if (graphSummary.taskSuccess < graphSummary.attempts) return "INCONCLUSIVE";
  if (oracleSummary.taskSuccess < oracleSummary.attempts && graphSummary.taskSuccess === graphSummary.attempts && evidence.trueCount === graphSummary.attempts) {
    return "ADDED_VALUE";
  }
  if (oracleSummary.taskSuccess < oracleSummary.attempts) return "INCONCLUSIVE";
  return "NO_ADDED_VALUE";
}

function taskReport({ baseline, graphRun, task }) {
  const noMemory = assertThreeAttempts(baseline, task.taskId, "no-memory");
  const oracleMemory = assertThreeAttempts(baseline, task.taskId, "oracle-memory");
  const memoryGraph = assertThreeAttempts(graphRun, task.taskId, GRAPH_CONDITION);
  const noMemorySummary = summarizeAttempts(noMemory);
  const oracleSummary = summarizeAttempts(oracleMemory);
  const graphSummary = summarizeAttempts(memoryGraph);
  const evidence = graphEvidenceSummary(memoryGraph);
  const decision = verdict({ oracleSummary, graphSummary, evidence });
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    conditions: {
      noMemory: noMemorySummary,
      oracleMemory: oracleSummary,
      memoryGraph: graphSummary,
    },
    evidence,
    decision,
    reason:
      decision === "NO_ADDED_VALUE"
        ? "oracle-memory and memory-graph both succeeded across all repetitions; Graph did not recover a stable oracle-memory failure."
        : "Graph evidence was insufficient for a stable added-value claim.",
  };
}

function buildMemoryGraphReport({ baseline, graphRun, graphLock, graphLockFileHash }) {
  validateInputs({ baseline, graphRun, graphLock, graphLockFileHash });
  const tasks = TASKS.map((task) => taskReport({ baseline, graphRun, task }));
  const overallDecision = tasks.every((task) => task.decision === "NO_ADDED_VALUE") ? "NO_ADDED_VALUE" : "INCONCLUSIVE";
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedFrom: {
      baselineRun: "plan014-utility",
      graphRun: "plan016-memory-graph",
    },
    hashes: {
      suiteHash: baseline.suiteHash,
      sourceLockHash: baseline.sourceLockHash,
      memoryIndexHash: baseline.memoryIndexHash,
      graphStatsHash: graphLock.graphStatsHash,
      graphLockHash: graphRun.graphLockHash,
    },
    comparison: {
      taskCount: tasks.length,
      baselineConditions: BASELINE_CONDITIONS,
      graphCondition: GRAPH_CONDITION,
      repetitionsPerCondition: 3,
      agent: graphRun.agent,
      agentOptions: graphRun.agentOptions,
    },
    tasks,
    overall: {
      decision: overallDecision,
      reason: "No task showed a stable oracle-memory failure recovered by Graph context.",
    },
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Plan016 Memory Graph Evaluation",
    "",
    `Overall decision: ${report.overall.decision}`,
    "",
    report.overall.reason,
    "",
    "## Run Identity",
    "",
    `- Suite hash: ${report.hashes.suiteHash}`,
    `- Source lock hash: ${report.hashes.sourceLockHash}`,
    `- Memory index hash: ${report.hashes.memoryIndexHash}`,
    `- Graph stats hash: ${report.hashes.graphStatsHash}`,
    "",
    "## Task Decisions",
    "",
    "| Task | Type | no-memory success | oracle success | memory-graph success | Evidence true/null | Graph calls avg | Graph latency avg ms | Decision |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const task of report.tasks) {
    lines.push(
      `| ${task.taskId} | ${task.taskType} | ${task.conditions.noMemory.taskSuccess}/3 | ${task.conditions.oracleMemory.taskSuccess}/3 | ${task.conditions.memoryGraph.taskSuccess}/3 | ${task.evidence.trueCount}/${task.evidence.nullCount} | ${task.conditions.memoryGraph.graphCallsAverage} | ${task.conditions.memoryGraph.graphLatencyMsAverage} | ${task.decision} |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const task of report.tasks) {
    lines.push(`- ${task.taskId}: ${task.reason}`);
  }
  return `${lines.join("\n")}\n`;
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
    const baseline = await readJson(options.baselinePath);
    const graphRun = await readJson(options.graphRunPath);
    const graphLockText = await readFile(options.graphLockPath, "utf8");
    const graphLock = JSON.parse(graphLockText);
    const report = buildMemoryGraphReport({ baseline, graphRun, graphLock, graphLockFileHash: sha256(graphLockText) });
    await writeText(options.jsonOutPath, canonicalBytes(report));
    await writeText(options.markdownOutPath, renderMarkdown(report));
    process.stdout.write(`${JSON.stringify({ schemaVersion: report.schemaVersion, decision: report.overall.decision, taskCount: report.tasks.length })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { buildMemoryGraphReport, canonicalBytes, parseArgs, renderMarkdown, sha256, summarizeAttempts, verdict };
