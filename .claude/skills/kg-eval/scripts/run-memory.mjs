#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadMemoryEvaluationInputs } from "./validate-memory-suite.mjs";
import { buildMemoryConditionInputs, MEMORY_CONDITIONS } from "./memory/condition.mjs";
import { runAgent, runArgvProcess } from "./memory/agent-runner.mjs";
import { normalizeAgentTelemetryJsonl, parseJsonl } from "./memory/telemetry.mjs";
import { judgeMemoryAttempt } from "./memory/judge.mjs";
import { withMemoryRun } from "./memory/result.mjs";
import { diffHash, materializeMemoryWorkspace, writeDiff } from "./memory/workspace.mjs";

const DEFAULT_DATA_DIR = "apps/pipeline/data";
const DEFAULT_OUT = "eval/runs/plan013-memory-smoke-run.json";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function usage() {
  return `Usage: node .claude/skills/kg-eval/scripts/run-memory.mjs --suite <suite.json> --source-lock <lock.json> [options]

Options:
  --out <path>                 Raw run JSON path (default: ${DEFAULT_OUT})
  --data-dir <path>            Memory data dir (default: ${DEFAULT_DATA_DIR})
  --agent <codex|claude>       Agent to execute
  --model <name>               Agent subscription model
  --effort <effort>            Agent effort option
  --permission-mode <mode>     Agent permission/sandbox option
  --tasks <ids>                Comma-separated task ids
  --conditions <names>         Comma-separated conditions
  --repeats <n>                Repetitions per task/condition (default: 1)
  --timeout-ms <n>             Agent timeout (default: ${DEFAULT_TIMEOUT_MS})
  --dry-run                    Validate and print planned aggregate only
  --help                       Show this help
`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set([
    "--suite",
    "--source-lock",
    "--out",
    "--data-dir",
    "--agent",
    "--model",
    "--effort",
    "--permission-mode",
    "--tasks",
    "--conditions",
    "--repeats",
    "--timeout-ms",
    "--max-output-bytes",
  ]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    args[arg.slice(2)] = value;
    index += 1;
  }
  for (const required of ["suite", "source-lock"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const repeats = args.repeats === undefined ? 1 : Number(args.repeats);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
  const timeoutMs = args["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(args["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer");
  const maxOutputBytes = args["max-output-bytes"] === undefined ? undefined : Number(args["max-output-bytes"]);
  if (maxOutputBytes !== undefined && (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1)) throw new Error("--max-output-bytes must be a positive integer");
  const conditions = csv(args.conditions) ?? ["agent-triggered"];
  const unknownConditions = conditions.filter((condition) => !MEMORY_CONDITIONS.includes(condition));
  if (unknownConditions.length > 0) throw new Error(`unsupported condition(s): ${unknownConditions.join(", ")}`);
  return {
    suitePath: args.suite,
    sourceLockPath: args["source-lock"],
    outPath: args.out ?? DEFAULT_OUT,
    dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR,
    agent: args.agent,
    agentOptions: {
      model: args.model,
      effort: args.effort,
      permissionMode: args["permission-mode"],
    },
    taskIds: csv(args.tasks),
    conditions,
    repeats,
    timeoutMs,
    maxOutputBytes,
    dryRun: Boolean(args.dryRun),
  };
}

function csv(value) {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function currentWikiIndexPath(dataDir, project) {
  const projectDirectory = path.join(dataDir, "memory", project);
  const pointer = JSON.parse(await readFile(path.join(projectDirectory, "current-wiki.json"), "utf8"));
  return path.join(projectDirectory, "wiki-generations", pointer.generationId, "index.json");
}

async function memoryIndexHash(dataDir, project) {
  const indexPath = await currentWikiIndexPath(dataDir, project);
  return `sha256:${await fileSha256(indexPath)}`;
}

function taskMap(sourceLock) {
  return new Map(sourceLock.tasks.map((task) => [task.taskId, task]));
}

function selectedTasks(suite, sourceLock, taskIds) {
  const privateByTask = taskMap(sourceLock);
  const selectedPublic = taskIds ? suite.tasks.filter((task) => taskIds.includes(task.id)) : suite.tasks;
  const missing = (taskIds ?? []).filter((taskId) => !suite.tasks.some((task) => task.id === taskId));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(", ")}`);
  return selectedPublic.map((task) => ({ publicTask: task, sourceTask: privateByTask.get(task.id) }));
}

async function runValidation(command, cwd) {
  if (!Array.isArray(command) || command.length === 0) return { status: 1, stdout: "", stderr: "missing validation command" };
  const result = await runArgvProcess({ command: command[0], args: command.slice(1), cwd, timeoutMs: 120_000, maxStdoutBytes: 256 * 1024, maxStderrBytes: 256 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
}

function buildAgentPrompt(input) {
  const memoryBlock = input.memoryInformation.memory ? `\n\nMemory context:\n${JSON.stringify(input.memoryInformation.memory, null, 2)}` : "";
  const searchCommandBlock = input.voluntaryMemorySearchCommand
    ? `\n\n${input.memoryTriggerInstruction}\n${input.voluntaryMemorySearchCommand}`
    : "";
  return [
    "You are executing a source-locked Coding Agent Memory benchmark task.",
    input.memoryInformation.instruction,
    "Modify only what is required, keep changes inside the repository, and run the provided validation command before stopping.",
    "",
    `Task:\n${input.prompt}`,
    "",
    `Validation command: ${input.validationCommand.join(" ")}`,
    searchCommandBlock,
    memoryBlock,
  ].join("\n");
}

function memorySearchArgv({ query, dataDir, devloopRoot }) {
  return [
    "pnpm",
    "--dir",
    path.resolve(devloopRoot),
    "--silent",
    "memory-search",
    "--",
    "--query",
    query,
    "--data-dir",
    path.resolve(dataDir),
    "--project",
    "tc-ocr",
    "--allow-incomplete",
  ];
}

function memorySearchCommand({ query, dataDir, devloopRoot }) {
  return memorySearchArgv({ query, dataDir, devloopRoot }).map(shellQuote).join(" ");
}

async function runMemorySearch({ query, dataDir, cwd }) {
  const result = await runArgvProcess({
    command: "pnpm",
    args: memorySearchArgv({ query, dataDir, devloopRoot: process.cwd() }).slice(1),
    cwd,
    timeoutMs: 180_000,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 128 * 1024,
  });
  if (result.status !== 0 || result.timedOut || result.outputOverflow) return { ok: false, reason: "process", result, memory: null };
  let memory;
  try {
    memory = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: "json", result, memory: null };
  }
  const usability = usableMemorySearchResult(memory);
  if (!usability.ok) return { ok: false, reason: usability.reason, result, memory: null };
  return { ok: true, result, memory };
}

function httpUrl(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function hasHttpSourceRef(value) {
  if (!value || typeof value !== "object") return false;
  if (httpUrl(value.url) || httpUrl(value.sourceUrl) || httpUrl(value.href)) return true;
  if (Array.isArray(value.sourceRefs) && value.sourceRefs.some(hasHttpSourceRef)) return true;
  if (Array.isArray(value.sources) && value.sources.some(hasHttpSourceRef)) return true;
  if (Array.isArray(value.evidence) && value.evidence.some(hasHttpSourceRef)) return true;
  return false;
}

function memorySearchResults(memory) {
  if (Array.isArray(memory?.results)) return memory.results;
  if (Array.isArray(memory?.documents)) return memory.documents;
  if (Array.isArray(memory?.items)) return memory.items;
  return null;
}

function usableMemorySearchResult(memory) {
  const results = memorySearchResults(memory);
  if (!Array.isArray(results)) return { ok: false, reason: "missingResults" };
  if (results.length === 0) return { ok: false, reason: "emptyResults" };
  if (!results.some(hasHttpSourceRef)) return { ok: false, reason: "missingHttpSourceRef" };
  return { ok: true };
}

function oracleFailureCounts(oracle) {
  return {
    process: oracle.reason === "process" ? 1 : 0,
    json: oracle.reason === "json" ? 1 : 0,
    missingResults: oracle.reason === "missingResults" ? 1 : 0,
    emptyResults: oracle.reason === "emptyResults" ? 1 : 0,
    missingHttpSourceRef: oracle.reason === "missingHttpSourceRef" ? 1 : 0,
  };
}

function taskInputs(tasks) {
  return tasks
    .map(({ sourceTask }) => ({
      taskId: sourceTask.taskId,
      baseRevision: sourceTask.baseRevision,
      validationCommand: sourceTask.validationCommand,
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function triggerMismatch(publicTask, attempt) {
  if (attempt.condition === "no-memory") return attempt.memoryCalls !== 0;
  if (attempt.condition === "oracle-memory") return attempt.memoryCalls < 1;
  if (attempt.condition === "agent-triggered") {
    if (publicTask.category === "code-only") return attempt.memoryCalls !== 0;
    if (publicTask.category === "experience-needed") return attempt.memoryCalls < 1;
  }
  return false;
}

function assertAcceptedAttempts({ attempts, selected, conditions, repeats }) {
  const publicByTask = new Map(selected.map(({ publicTask }) => [publicTask.id, publicTask]));
  const selectedKeys = new Set();
  for (const { publicTask } of selected) {
    for (const condition of conditions) {
      for (let repetition = 1; repetition <= repeats; repetition += 1) selectedKeys.add(`${publicTask.id}:${condition}:${repetition}`);
    }
  }
  const selectedAttempts = attempts.filter((attempt) => selectedKeys.has(`${attempt.taskId}:${attempt.condition}:${attempt.repetition}`));
  const failures = {
    missing: selectedKeys.size - selectedAttempts.length,
    agentStatus: 0,
    timedOut: 0,
    overflow: 0,
    validation: 0,
    taskFailure: 0,
    triggerMismatch: 0,
  };
  for (const attempt of selectedAttempts) {
    if (attempt.status !== 0) failures.agentStatus += 1;
    if (attempt.timedOut) failures.timedOut += 1;
    if (attempt.outputOverflow) failures.overflow += 1;
    if (attempt.validationStatus !== 0) failures.validation += 1;
    if (attempt.taskSuccess !== true) failures.taskFailure += 1;
    const publicTask = publicByTask.get(attempt.taskId);
    if (!publicTask || triggerMismatch(publicTask, attempt)) failures.triggerMismatch += 1;
  }
  const totalFailures = Object.values(failures).reduce((sum, count) => sum + count, 0);
  if (totalFailures > 0) {
    const error = new Error(`memory run acceptance failed: ${JSON.stringify(failures)}`);
    error.failures = failures;
    throw error;
  }
}

async function executeAttempt({ options, sourceTask, condition, repetition, runKey, rootCwd }) {
  const runtimeRoot = options.runtimeRoot ?? path.dirname(options.outPath);
  const { workspacePath } = await materializeMemoryWorkspace({
    source: sourceTask,
    runKey,
    runsRoot: options.workspaceRoot ?? path.join(runtimeRoot, "workspaces"),
  });
  const oracle =
    condition === "oracle-memory"
      ? await (options.runMemorySearchFn ?? runMemorySearch)({ query: sourceTask.oracleQuery, dataDir: options.dataDir, cwd: rootCwd })
      : { ok: true, result: null, memory: null };
  if (!oracle.ok) {
    const error = new Error(`oracle memory unavailable: ${JSON.stringify(oracleFailureCounts(oracle))}`);
    error.failures = oracleFailureCounts(oracle);
    throw error;
  }
  const input = buildMemoryConditionInputs({ task: sourceTask, oracleMemory: oracle.memory }).find((item) => item.condition === condition);
  const voluntaryMemorySearchCommand =
    condition === "agent-triggered"
      ? memorySearchCommand({ query: sourceTask.oracleQuery, dataDir: options.dataDir, devloopRoot: rootCwd })
      : null;
  const memoryTriggerInstruction =
    condition === "agent-triggered" && options.publicTask?.category === "experience-needed"
      ? "This task is classified as experience-needed; run this exact Experience Memory search command once before editing:"
      : "Use this exact command if Experience Memory search is warranted:";
  const startedAt = Date.now();
  const runAgentFn = options.runAgentFn ?? runAgent;
  const agentResult = await runAgentFn({
    agent: options.agent,
    prompt: buildAgentPrompt({ ...input, voluntaryMemorySearchCommand, memoryTriggerInstruction }),
    cwd: workspacePath,
    agentOptions: options.agentOptions,
    timeoutMs: options.timeoutMs,
    ...(options.maxOutputBytes === undefined ? {} : { maxStdoutBytes: options.maxOutputBytes, maxStderrBytes: options.maxOutputBytes }),
  });
  const wallTimeMs = Date.now() - startedAt;
  const transcriptRoot = options.transcriptRoot ?? path.join(runtimeRoot, "transcripts");
  await mkdir(transcriptRoot, { recursive: true });
  const stdoutTranscriptPath = path.join(transcriptRoot, `${runKey}.stdout.jsonl`);
  const stderrTranscriptPath = path.join(transcriptRoot, `${runKey}.stderr.txt`);
  await writeFile(stdoutTranscriptPath, agentResult.stdout);
  await writeFile(stderrTranscriptPath, agentResult.stderr);
  let events = [];
  try {
    events = parseJsonl(agentResult.stdout);
  } catch {
    events = [];
  }
  const telemetry = normalizeAgentTelemetryJsonl(agentResult.stdout);
  if (oracle.result) telemetry.memoryCalls += 1;
  const validationResult = await runValidation(sourceTask.validationCommand, workspacePath);
  const workspaceDiffHash = await diffHash(workspacePath);
  const diffRoot = options.diffRoot ?? path.join(runtimeRoot, "memory-diffs");
  const diffPath = path.join(diffRoot, `${runKey}.patch`);
  await writeDiff(workspacePath, diffPath);
  const judgment = judgeMemoryAttempt({
    validationResult,
    allowedPaths: sourceTask.allowedPaths,
    diff: { patch: await readFile(diffPath, "utf8") },
    events,
  });
  return {
    taskId: sourceTask.taskId,
    condition,
    repetition,
    agent: options.agent,
    agentOptions: options.agentOptions,
    status: agentResult.status,
    signal: agentResult.signal,
    timedOut: agentResult.timedOut,
    outputOverflow: agentResult.outputOverflow,
    stdoutTranscriptPath,
    stderrTranscriptPath,
    wallTimeMs,
    validationStatus: validationResult.status,
    failureBoundary: judgment.taskSuccess ? "NONE" : validationResult.status === 0 ? "IMPLEMENTATION" : "VALIDATION",
    workspaceDiffHash,
    ...telemetry,
    ...judgment,
  };
}

async function runMemoryEvaluation(options) {
  if (!options.agent && !options.dryRun) throw new Error("--agent is required unless --dry-run is used");
  const inputs = await loadMemoryEvaluationInputs({ suitePath: options.suitePath, sourceLockPath: options.sourceLockPath });
  const indexHash = await memoryIndexHash(options.dataDir, inputs.suite.project);
  const tasks = selectedTasks(inputs.suite, inputs.sourceLock, options.taskIds);
  const plannedAttempts = tasks.length * options.conditions.length * options.repeats;
  const summary = {
    schemaVersion: "memory-eval-runner/v1",
    suiteHash: inputs.suiteHash,
    sourceLockHash: inputs.sourceLockHash,
    memoryIndexHash: indexHash,
    taskCount: tasks.length,
    plannedAttempts,
  };
  if (options.dryRun) return { ...summary, dryRun: true };

  const rootCwd = process.cwd();
  await mkdir(path.dirname(options.outPath), { recursive: true });
  let completed = 0;
  let storedRun;
  await withMemoryRun(
    options.outPath,
    {
      suitePath: options.suitePath,
      sourceLockPath: options.sourceLockPath,
      suiteHash: inputs.suiteHash,
      sourceLockHash: inputs.sourceLockHash,
      taskInputs: taskInputs(tasks),
      memoryIndexHash: indexHash,
    },
    async ({ run, upsert }) => {
      storedRun = run;
      const existingKeys = new Set(run.attempts.map((attempt) => `${attempt.taskId}:${attempt.condition}:${attempt.repetition}`));
      for (const { publicTask, sourceTask } of tasks) {
        for (const condition of options.conditions) {
          for (let repetition = 1; repetition <= options.repeats; repetition += 1) {
            const key = `${sourceTask.taskId}:${condition}:${repetition}`;
            if (existingKeys.has(key)) continue;
            const runKey = `${sourceTask.taskId}-${condition}-${repetition}`.replace(/[^A-Za-z0-9_.-]/g, "-");
            const attempt = await executeAttempt({ options: { ...options, publicTask }, sourceTask, condition, repetition, runKey, rootCwd });
            await upsert(attempt);
            completed += 1;
          }
        }
      }
    },
  );
  if (storedRun) assertAcceptedAttempts({ attempts: storedRun.attempts, selected: tasks, conditions: options.conditions, repeats: options.repeats });
  return { ...summary, completedAttempts: completed, outPath: options.outPath };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await runMemoryEvaluation(options);
    await writeFile("/dev/stdout", `${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export {
  assertAcceptedAttempts,
  buildAgentPrompt,
  memoryIndexHash,
  memorySearchArgv,
  memorySearchCommand,
  parseArgs,
  runMemoryEvaluation,
  usableMemorySearchResult,
  usage,
};
