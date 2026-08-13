const MEMORY_CONDITIONS = ["no-memory", "agent-triggered", "oracle-memory"];
const EXPERIMENTAL_MEMORY_CONDITIONS = ["memory-graph"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireTaskField(task, field) {
  if (typeof task?.[field] === "string" && task[field].trim().length > 0) return task[field];
  if (Array.isArray(task?.[field]) && task[field].length > 0) return clone(task[field]);
  throw new Error(`task.${field} is required`);
}

function baseInput(task) {
  const baseRevision = requireTaskField(task, "baseRevision");
  return {
    taskId: requireTaskField(task, "taskId"),
    prompt: requireTaskField(task, "prompt"),
    baseRevision,
    revision: baseRevision,
    allowedPaths: requireTaskField(task, "allowedPaths"),
    validationCommand: requireTaskField(task, "validationCommand"),
  };
}

function memoryInformationFor(condition, { oracleMemory = null } = {}) {
  if (condition === "no-memory") {
    return {
      mode: "none",
      instruction: "Do not use Experience Memory for this condition.",
      memory: null,
    };
  }
  if (condition === "agent-triggered") {
    return {
      mode: "voluntary-search",
      instruction: "Use the repository voluntary policy to decide whether to run `pnpm --silent memory-search`.",
      memory: null,
    };
  }
  return {
    mode: "provided-oracle",
    instruction: "Use only the provided Memory context for this condition; do not run additional Memory search.",
    memory: oracleMemory,
  };
}

function graphMemoryInformation({ oracleMemory, graphContext }) {
  return {
    mode: "provided-oracle-graph",
    instruction: "Use only the provided Memory context and Graph context for this condition; do not run additional Memory or Graph searches.",
    memory: oracleMemory,
    graphContext,
  };
}

function buildMemoryConditionInputs({ task, oracleMemory = null }) {
  const shared = baseInput(task);
  return MEMORY_CONDITIONS.map((condition) => ({
    ...clone(shared),
    condition,
    memoryInformation: memoryInformationFor(condition, { oracleMemory }),
  }));
}

function buildExperimentalMemoryConditionInput({ task, condition, oracleMemory = null, graphContext = null }) {
  if (!EXPERIMENTAL_MEMORY_CONDITIONS.includes(condition)) {
    throw new Error(`unsupported experimental memory condition: ${condition}`);
  }
  return {
    ...clone(baseInput(task)),
    condition,
    memoryInformation: graphMemoryInformation({ oracleMemory, graphContext }),
  };
}

function assertOnlyMemoryInformationDiffers(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== MEMORY_CONDITIONS.length) {
    throw new Error(`expected ${MEMORY_CONDITIONS.length} memory condition inputs`);
  }
  const baseline = JSON.stringify({ ...inputs[0], condition: undefined, memoryInformation: undefined });
  for (const input of inputs) {
    const comparable = JSON.stringify({ ...input, condition: undefined, memoryInformation: undefined });
    if (comparable !== baseline) {
      throw new Error("memory conditions must share task prompt, base revision, allowed paths, and validation command");
    }
  }
  return true;
}

export { EXPERIMENTAL_MEMORY_CONDITIONS, MEMORY_CONDITIONS, assertOnlyMemoryInformationDiffers, buildExperimentalMemoryConditionInput, buildMemoryConditionInputs, memoryInformationFor };
