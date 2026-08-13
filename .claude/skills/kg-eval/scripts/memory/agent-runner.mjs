import { spawn } from "node:child_process";

const AGENTS = new Set(["codex", "claude"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const COMPARABLE_OPTION_KEYS = ["model", "effort", "permissionMode"];
const IS_WINDOWS = process.platform === "win32";
const PRE_TOOL_AVAILABILITY_CODES = new Set(["subscription_limit_exceeded", "usage_limit_exceeded", "rate_limit_exceeded"]);

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertAgent(agent) {
  if (!AGENTS.has(agent)) {
    throw new Error(`unsupported agent: ${agent ?? ""}`);
  }
}

function comparableAgentOptions(options = {}) {
  return Object.fromEntries(COMPARABLE_OPTION_KEYS.map((key) => [key, options[key] ?? null]));
}

function assertEquivalentAgentOptions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error("conditions must contain at least one item");
  }
  const baseline = comparableAgentOptions(conditions[0].agentOptions ?? conditions[0]);
  for (let index = 1; index < conditions.length; index += 1) {
    const current = comparableAgentOptions(conditions[index].agentOptions ?? conditions[index]);
    for (const key of COMPARABLE_OPTION_KEYS) {
      if (current[key] !== baseline[key]) {
        throw new Error(`agent ${key} must not differ across memory conditions`);
      }
    }
  }
  return baseline;
}

function appendCodexOptions(args, options = {}) {
  if (hasText(options.model)) {
    args.push("--model", options.model);
  }
  if (hasText(options.effort)) {
    args.push("-c", `model_reasoning_effort="${options.effort}"`);
  }
  if (hasText(options.permissionMode)) {
    args.push("--sandbox", options.permissionMode);
  }
}

function appendClaudeOptions(args, options = {}) {
  if (hasText(options.model)) {
    args.push("--model", options.model);
  }
  if (hasText(options.effort)) {
    args.push("--effort", options.effort);
  }
  if (hasText(options.permissionMode)) {
    args.push("--permission-mode", options.permissionMode);
  }
}

function buildAgentInvocation({ agent, prompt, agentOptions = {} }) {
  assertAgent(agent);
  if (!hasText(prompt)) {
    throw new Error("prompt must be a non-empty string");
  }
  if (agent === "codex") {
    const args = ["exec", "--json"];
    appendCodexOptions(args, agentOptions);
    args.push(prompt);
    return { command: "codex", args };
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  appendClaudeOptions(args, agentOptions);
  args.push(prompt);
  return { command: "claude", args };
}

function signalProcessTree(child, signal) {
  if (IS_WINDOWS) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function pushBounded(buffer, chunk, maxBytes, label, requestTerminate, state) {
  if (state.outputOverflow) return;
  const nextBytes = buffer.bytes + chunk.byteLength;
  if (nextBytes > maxBytes) {
    state.outputOverflow = label;
    requestTerminate();
    return;
  }
  buffer.bytes = nextBytes;
  buffer.parts.push(chunk);
}

function runArgvProcess({
  command,
  args = [],
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxStdoutBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxStderrBytes = DEFAULT_MAX_OUTPUT_BYTES,
  env = process.env,
}) {
  if (!hasText(command)) {
    throw new Error("command must be a non-empty string");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WINDOWS });
    const stdout = { parts: [], bytes: 0 };
    const stderr = { parts: [], bytes: 0 };
    const state = { outputOverflow: null };
    let settled = false;
    let timedOut = false;
    let terminating = false;
    let finalKillDelivered = false;
    let pendingCloseResult = null;
    let killTimer;
    const resolveCloseIfReady = () => {
      if (!pendingCloseResult || (terminating && !finalKillDelivered)) return;
      finish(resolve, pendingCloseResult);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      callback(value);
    };
    const requestTerminate = () => {
      if (terminating) return;
      terminating = true;
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        finalKillDelivered = true;
        signalProcessTree(child, "SIGKILL");
        resolveCloseIfReady();
      }, killGraceMs);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTerminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      pushBounded(stdout, chunk, maxStdoutBytes, "stdout", requestTerminate, state);
    });
    child.stderr.on("data", (chunk) => {
      pushBounded(stderr, chunk, maxStderrBytes, "stderr", requestTerminate, state);
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (status, signal) => {
      pendingCloseResult = {
        status,
        signal,
        timedOut,
        outputOverflow: state.outputOverflow,
        stdout: Buffer.concat(stdout.parts).toString("utf8"),
        stderr: Buffer.concat(stderr.parts).toString("utf8"),
      };
      resolveCloseIfReady();
    });
  });
}

async function runAgent({ agent, prompt, cwd, agentOptions = {}, ...processOptions }) {
  const invocation = buildAgentInvocation({ agent, prompt, agentOptions });
  return runArgvProcess({ ...invocation, cwd, ...processOptions });
}

function eventNormalizedCode(event) {
  const code =
    event?.normalizedCode ??
    event?.normalized_code ??
    event?.error?.normalizedCode ??
    event?.error?.normalized_code ??
    event?.error?.code ??
    event?.code;
  return typeof code === "string" ? code : null;
}

function isToolOrCommandEvent(event) {
  if (event?.item?.type === "command_execution") return true;
  const content = event?.message?.content ?? event?.content;
  return Array.isArray(content) && content.some((item) => item?.type === "tool_use");
}

function structuredPreToolAvailabilityFailure(events) {
  for (const event of events ?? []) {
    if (isToolOrCommandEvent(event)) return null;
    const normalizedCode = eventNormalizedCode(event);
    if (PRE_TOOL_AVAILABILITY_CODES.has(normalizedCode)) return { normalizedCode };
  }
  return null;
}

function spawnAvailabilityFailure(error) {
  if (!error || typeof error !== "object") return null;
  if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return { normalizedCode: "agent_spawn_failed" };
  return null;
}

export {
  AGENTS,
  COMPARABLE_OPTION_KEYS,
  PRE_TOOL_AVAILABILITY_CODES,
  buildAgentInvocation,
  assertEquivalentAgentOptions,
  comparableAgentOptions,
  runAgent,
  runArgvProcess,
  spawnAvailabilityFailure,
  structuredPreToolAvailabilityFailure,
};
