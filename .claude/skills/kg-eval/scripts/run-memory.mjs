#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadMemoryEvaluationInputs } from "./validate-memory-suite.mjs";
import { buildMemoryConditionInputs, MEMORY_CONDITIONS } from "./memory/condition.mjs";
import { runAgent, runArgvProcess, spawnAvailabilityFailure, structuredPreToolAvailabilityFailure } from "./memory/agent-runner.mjs";
import { normalizeAgentTelemetryJsonl, parseJsonl } from "./memory/telemetry.mjs";
import { judgeMemoryAttempt } from "./memory/judge.mjs";
import { canonicalExecutionPlan, withMemoryRun } from "./memory/result.mjs";
import { retrievalObservations } from "./memory/retrieval-observation.mjs";
import { cleanupActiveWorkspaceRoot, cleanupLegacyWorkspaceRoot, diffHash, materializeMemoryWorkspace, prepareActiveWorkspaceRoot, writeDiff } from "./memory/workspace.mjs";

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
  --schedule <name>            Attempt order: default or interleaved (default: default)
  --timeout-ms <n>             Agent timeout (default: ${DEFAULT_TIMEOUT_MS})
  --require-expected-trigger   Require expected Memory trigger behavior in the agent prompt for experience-needed smokes
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
    "--schedule",
  ]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--require-expected-trigger") {
      args.requireExpectedTrigger = true;
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
  const schedule = args.schedule ?? "default";
  if (!["default", "interleaved"].includes(schedule)) throw new Error("--schedule must be default or interleaved");
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
    schedule,
    requireExpectedTrigger: Boolean(args.requireExpectedTrigger),
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
    "Modify only what is required, keep changes inside the repository, do not read sibling benchmark workspaces or run artifacts, and run the provided validation command before stopping.",
    "The provided Experience Memory search command is the only allowed external read for this benchmark prompt.",
    "",
    `Task:\n${input.prompt}`,
    "",
    `Validation command: ${input.validationCommand.join(" ")}`,
    searchCommandBlock,
    memoryBlock,
  ].join("\n");
}

function memorySearchArgv({ query, dataDir, devloopRoot, topK }) {
  const argv = [
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
  if (topK !== undefined) argv.push("--top-k", String(topK));
  return argv;
}

function memorySearchCommand({ query, dataDir, devloopRoot }) {
  return memorySearchArgv({ query, dataDir, devloopRoot }).map(shellQuote).join(" ");
}

async function runMemorySearch({ query, dataDir, cwd, topK }) {
  const result = await runArgvProcess({
    command: "pnpm",
    args: memorySearchArgv({ query, dataDir, devloopRoot: process.cwd(), topK }).slice(1),
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
  const agentMemoryCalls = attempt.agentMemoryCalls ?? attempt.memoryCalls;
  if (attempt.condition === "no-memory") return agentMemoryCalls !== 0;
  if (attempt.condition === "oracle-memory") return (attempt.oracleMemoryProvided ?? 0) !== 1 || agentMemoryCalls !== 0;
  if (attempt.condition === "agent-triggered") {
    if (publicTask.category === "code-only") return agentMemoryCalls !== 0;
    if (publicTask.category === "experience-needed") return agentMemoryCalls < 1;
  }
  return false;
}

function triggerOutcome(publicTask, attempt) {
  const agentMemoryCalls = attempt.agentMemoryCalls ?? attempt.memoryCalls;
  if (attempt.condition === "no-memory") return agentMemoryCalls === 0 ? "expected_skip" : "contaminated_search";
  if (attempt.condition === "oracle-memory") {
    if ((attempt.oracleMemoryProvided ?? 0) !== 1) return "oracle_missing";
    return agentMemoryCalls === 0 ? "oracle_provided" : "contaminated_search";
  }
  if (publicTask?.category === "code-only") return agentMemoryCalls === 0 ? "expected_skip" : "unexpected_search";
  if (publicTask?.category === "experience-needed") return agentMemoryCalls > 0 ? "expected_search" : "missed_search";
  return "not_applicable";
}

function assertAcceptedAttempts({ attempts, selected, conditions, repeats, requireExpectedTrigger = false }) {
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
    conditionContamination: 0,
    triggerMismatch: 0,
  };
  for (const attempt of selectedAttempts) {
    const publicTask = publicByTask.get(attempt.taskId);
    const agentMemoryCalls = attempt.agentMemoryCalls ?? attempt.memoryCalls;
    if (attempt.workspaceContamination) failures.conditionContamination += 1;
    if (attempt.condition === "no-memory" && agentMemoryCalls !== 0) failures.conditionContamination += 1;
    if (attempt.condition === "oracle-memory" && ((attempt.oracleMemoryProvided ?? 0) !== 1 || agentMemoryCalls !== 0)) failures.conditionContamination += 1;
    if (requireExpectedTrigger && (!publicTask || triggerMismatch(publicTask, attempt))) failures.triggerMismatch += 1;
  }
  const totalFailures = Object.values(failures).reduce((sum, count) => sum + count, 0);
  if (totalFailures > 0) {
    const error = new Error(`memory run acceptance failed: ${JSON.stringify(failures)}`);
    error.failures = failures;
    throw error;
  }
}

function buildAttemptSchedule({ tasks, conditions, repeats, schedule = "default" }) {
  const attempts = [];
  for (const task of tasks) {
    if (schedule === "interleaved") {
      for (let repetition = 1; repetition <= repeats; repetition += 1) {
        for (const condition of conditions) attempts.push({ task, condition, repetition });
      }
      continue;
    }
    for (const condition of conditions) {
      for (let repetition = 1; repetition <= repeats; repetition += 1) attempts.push({ task, condition, repetition });
    }
  }
  return attempts;
}

function availabilityFailureRecord({ sourceTask, condition, repetition, normalizedCode }) {
  return {
    taskId: sourceTask.taskId,
    condition,
    repetition,
    normalizedCode,
  };
}

function executionPlanFromOptions(options) {
  return canonicalExecutionPlan({
    conditions: options.conditions,
    repeats: options.repeats,
    schedule: options.schedule ?? "default",
    requireExpectedTrigger: Boolean(options.requireExpectedTrigger),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? null,
  });
}

function commandText(command) {
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string") return command;
  if (Array.isArray(command?.argv)) return command.argv.join(" ");
  if (typeof command?.command === "string") return command.command;
  return "";
}

function commandEvents(events) {
  const commands = [];
  for (const event of events ?? []) {
    if (event?.item?.type === "command_execution") commands.push(event.item.command ?? event.item.argv ?? event.item);
    const content = event?.message?.content ?? event?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== "tool_use" || item.name !== "Bash") continue;
      commands.push(item.input?.command ?? item.input?.cmd ?? item.input);
    }
  }
  return commands;
}

function detectWorkspaceContamination(events) {
  const forbiddenPathPattern =
    /(^|[\s"'`([{/])(?:\.\.\/MEM-[A-Za-z0-9_.-]+|(?:\.\/)?eval\/runs\/(?:workspaces|active-workspace|memory-diffs|transcripts)(?:\/|$)|(?:\.\.\/)*(?:\.\/)?(?:memory-diffs|transcripts)\/MEM-[A-Za-z0-9_.-]+)/;
  const contaminatedCommands = commandEvents(events)
    .map((command) => commandText(command).replace(/\s+/g, " "))
    .filter((text) => forbiddenPathPattern.test(text));
  return {
    workspaceContamination: contaminatedCommands.length > 0,
    workspaceContaminationCount: contaminatedCommands.length,
  };
}

async function requiredMemoryIdsForAttempt({ options, sourceTask, topK, rootCwd }) {
  const oracle = await (options.runMemorySearchFn ?? runMemorySearch)({ query: sourceTask.oracleQuery, dataDir: options.dataDir, cwd: rootCwd, topK });
  if (!oracle.ok) return [];
  return memorySearchResults(oracle.memory)?.map((item) => item?.id).filter((id) => typeof id === "string" && id.length > 0) ?? [];
}

async function executeAttempt({ options, sourceTask, condition, repetition, runKey, rootCwd }) {
  const runtimeRoot = options.runtimeRoot ?? path.dirname(options.outPath);
  const workspaceRoot = await prepareActiveWorkspaceRoot({ runtimeRoot });
  try {
    const { workspacePath } = await materializeMemoryWorkspace({
      source: sourceTask,
      runKey,
      runsRoot: workspaceRoot,
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
      condition === "agent-triggered" && options.requireExpectedTrigger && options.publicTask?.category === "experience-needed"
        ? "This task is classified as experience-needed; run this exact Experience Memory search command once before editing:"
        : "Use this exact command if Experience Memory search is warranted:";
    const startedAt = Date.now();
    const runAgentFn = options.runAgentFn ?? runAgent;
    let agentResult;
    try {
      agentResult = await runAgentFn({
        agent: options.agent,
        prompt: buildAgentPrompt({ ...input, voluntaryMemorySearchCommand, memoryTriggerInstruction }),
        cwd: workspacePath,
        agentOptions: options.agentOptions,
        timeoutMs: options.timeoutMs,
        ...(options.maxOutputBytes === undefined ? {} : { maxStdoutBytes: options.maxOutputBytes, maxStderrBytes: options.maxOutputBytes }),
      });
    } catch (error) {
      const availabilityFailure = spawnAvailabilityFailure(error);
      if (availabilityFailure) return { availabilityFailure };
      throw error;
    }
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
    const preToolAvailabilityFailure = structuredPreToolAvailabilityFailure(events);
    if (preToolAvailabilityFailure) {
      return { availabilityFailure: preToolAvailabilityFailure };
    }
    const telemetry = normalizeAgentTelemetryJsonl(agentResult.stdout);
    const agentMemoryCalls = telemetry.memoryCalls;
    const oracleMemoryProvided = oracle.result ? 1 : 0;
    telemetry.memoryCalls += oracleMemoryProvided;
    let observedRetrievals = [];
    if (condition === "agent-triggered") {
      const preliminary = retrievalObservations({
        agent: options.agent,
        events,
        sourceRunKey: runKey,
        requiredMemoryIds: [],
        currentMemoryIndexHash: options.memoryIndexHash,
      });
      const requiredByTopK = new Map();
      for (const observation of preliminary) {
        if (!requiredByTopK.has(observation.topK)) {
          requiredByTopK.set(observation.topK, await requiredMemoryIdsForAttempt({ options, sourceTask, topK: observation.topK, rootCwd }));
        }
      }
      observedRetrievals = retrievalObservations({
        agent: options.agent,
        events,
        sourceRunKey: runKey,
        requiredMemoryIds: requiredByTopK,
        currentMemoryIndexHash: options.memoryIndexHash,
      });
    }
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
    const contamination = detectWorkspaceContamination(events);
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
      failureBoundary: contamination.workspaceContamination ? "MEMORY" : judgment.taskSuccess ? "NONE" : validationResult.status === 0 ? "IMPLEMENTATION" : "VALIDATION",
      workspaceDiffHash,
      ...telemetry,
      agentMemoryCalls,
      oracleMemoryProvided,
      ...contamination,
      triggerOutcome: triggerOutcome(options.publicTask, { condition, memoryCalls: telemetry.memoryCalls, agentMemoryCalls, oracleMemoryProvided }),
      ...(condition === "agent-triggered" ? { retrievalObservations: observedRetrievals } : {}),
      ...judgment,
    };
  } finally {
    await cleanupActiveWorkspaceRoot({ runtimeRoot, activeWorkspaceRoot: workspaceRoot });
  }
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
  await cleanupLegacyWorkspaceRoot({ runtimeRoot: path.dirname(options.outPath) });
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
      executionPlan: executionPlanFromOptions(options),
      agent: options.agent,
      agentOptions: options.agentOptions,
    },
    async ({ run, appendAttempt, appendAvailabilityFailure }) => {
      storedRun = run;
      const existingKeys = new Set(run.attempts.map((attempt) => `${attempt.taskId}:${attempt.condition}:${attempt.repetition}`));
      const schedule = buildAttemptSchedule({ tasks, conditions: options.conditions, repeats: options.repeats, schedule: options.schedule });
      for (const { task, condition, repetition } of schedule) {
        const { publicTask, sourceTask } = task;
        const key = `${sourceTask.taskId}:${condition}:${repetition}`;
        if (existingKeys.has(key)) continue;
        const runKey = `${sourceTask.taskId}-${condition}-${repetition}`.replace(/[^A-Za-z0-9_.-]/g, "-");
        const result = await executeAttempt({
          options: { ...options, publicTask, memoryIndexHash: indexHash },
          sourceTask,
          condition,
          repetition,
          runKey,
          rootCwd,
        });
        if (result.availabilityFailure) {
          await appendAvailabilityFailure(availabilityFailureRecord({ sourceTask, condition, repetition, normalizedCode: result.availabilityFailure.normalizedCode }));
          return;
        }
        await appendAttempt(result);
        existingKeys.add(key);
        completed += 1;
      }
    },
  );
  if (storedRun && (storedRun.availabilityFailures?.length ?? 0) === 0) {
    assertAcceptedAttempts({ attempts: storedRun.attempts, selected: tasks, conditions: options.conditions, repeats: options.repeats, requireExpectedTrigger: options.requireExpectedTrigger });
  }
  return { ...summary, completedAttempts: completed, availabilityFailures: storedRun?.availabilityFailures?.length ?? 0, outPath: options.outPath };
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
  buildAttemptSchedule,
  buildAgentPrompt,
  detectWorkspaceContamination,
  memoryIndexHash,
  memorySearchArgv,
  memorySearchCommand,
  parseArgs,
  runMemoryEvaluation,
  usableMemorySearchResult,
  usage,
};
