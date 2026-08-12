#!/usr/bin/env node
import process from "node:process";
import { loadMemorySuite } from "./memory/suite.mjs";
import { loadSourceLock, validateSuiteSourceLockPair } from "./memory/source-lock.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--suite" && arg !== "--source-lock") {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    args[arg.slice(2)] = value;
    index += 1;
  }
  if (!args.suite) {
    throw new Error("--suite is required");
  }
  if (!args["source-lock"]) {
    throw new Error("--source-lock is required");
  }
  return { suitePath: args.suite, sourceLockPath: args["source-lock"] };
}

async function loadMemoryEvaluationInputs({ suitePath, sourceLockPath }) {
  const suiteResult = await loadMemorySuite(suitePath);
  const sourceLockResult = await loadSourceLock(sourceLockPath);
  const errors = [
    ...suiteResult.errors.map((error) => `suite ${error}`),
    ...sourceLockResult.errors.map((error) => `sourceLock ${error}`),
    ...validateSuiteSourceLockPair(suiteResult.suite, sourceLockResult.sourceLock),
  ];
  if (errors.length > 0) {
    const error = new Error(`memory suite validation failed:\n${errors.join("\n")}`);
    error.errors = errors;
    throw error;
  }
  return {
    schemaVersion: suiteResult.suite.schemaVersion,
    suite: suiteResult.suite,
    sourceLock: sourceLockResult.sourceLock,
    suiteHash: suiteResult.hash,
    sourceLockHash: sourceLockResult.hash,
    taskCount: suiteResult.suite.tasks.length,
  };
}

async function main() {
  try {
    const inputs = await loadMemoryEvaluationInputs(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: inputs.schemaVersion,
        suiteHash: inputs.suiteHash,
        sourceLockHash: inputs.sourceLockHash,
        taskCount: inputs.taskCount,
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

export { loadMemoryEvaluationInputs, parseArgs };
