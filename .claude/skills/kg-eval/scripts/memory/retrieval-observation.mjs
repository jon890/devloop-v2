import { isMemoryCommand, tokenizeCommand } from "./telemetry.mjs";

const DEFAULT_TOP_K = 10;

function commandText(command) {
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string") return command;
  if (Array.isArray(command?.argv)) return command.argv.join(" ");
  if (typeof command?.command === "string") return command.command;
  return "";
}

function commandArgv(command) {
  if (Array.isArray(command)) return command.map(String);
  if (Array.isArray(command?.argv)) return command.argv.map(String);
  return tokenizeCommand(commandText(command));
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function memorySearchDetails(command) {
  const argv = commandArgv(command);
  const query = flagValue(argv, "--query");
  if (!query) return null;
  const topKValue = flagValue(argv, "--top-k");
  const topK = topKValue === null ? DEFAULT_TOP_K : Number(topKValue);
  if (!Number.isInteger(topK) || topK < 1) return null;
  return { query, topK };
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .join("");
  }
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.content === "string") return value.content;
  if (typeof value?.stdout === "string") return value.stdout;
  return "";
}

function parseJsonOutput(value) {
  const text = outputText(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function commandOutput(item) {
  return item?.output ?? item?.stdout ?? item?.result ?? item?.content;
}

function resultIds(result) {
  return Array.isArray(result?.results) ? result.results.map((item) => item?.id).filter((id) => typeof id === "string" && id.length > 0) : null;
}

function observedMemoryIndexHash(parsedOutput) {
  const hash = parsedOutput?.memoryIndexHash ?? parsedOutput?.indexHash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

function observedOutcome(retrievedMemoryIds, requiredMemoryIds) {
  if (!retrievedMemoryIds) return "unobserved";
  const required = new Set(requiredMemoryIds);
  if (required.size > 0 && retrievedMemoryIds.some((id) => required.has(id))) return "hit";
  return "miss";
}

function requiredIdsForTopK(requiredMemoryIds, topK) {
  if (requiredMemoryIds instanceof Map) return requiredMemoryIds.get(topK) ?? [];
  return requiredMemoryIds;
}

function observationFromCommand({ sourceRunKey, command, output, requiredMemoryIds, currentMemoryIndexHash }) {
  if (!isMemoryCommand(command)) return null;
  const details = memorySearchDetails(command);
  const parsedOutput = parseJsonOutput(output);
  const retrievedMemoryIds = resultIds(parsedOutput);
  const memoryIndexHash = observedMemoryIndexHash(parsedOutput);
  const sameIndex = memoryIndexHash === currentMemoryIndexHash;
  const requiredForObservedTopK = details ? requiredIdsForTopK(requiredMemoryIds, details.topK) : [];
  const required = details && parsedOutput && sameIndex ? requiredForObservedTopK : [];
  const observable = Boolean(details && retrievedMemoryIds && sameIndex);
  return {
    sourceRunKey,
    query: details?.query ?? null,
    topK: details?.topK ?? DEFAULT_TOP_K,
    requiredMemoryIds: required,
    retrievedMemoryIds: retrievedMemoryIds ?? [],
    memoryIndexHash,
    outcome: observable ? observedOutcome(retrievedMemoryIds, required) : "unobserved",
  };
}

function codexRetrievalObservations({ events, sourceRunKey, requiredMemoryIds, currentMemoryIndexHash }) {
  const observations = [];
  for (const event of events ?? []) {
    if (event?.type !== "item.completed" || event.item?.type !== "command_execution") continue;
    const command = event.item.command ?? event.item.argv ?? event.item;
    const observation = observationFromCommand({
      sourceRunKey,
      command,
      output: commandOutput(event.item),
      requiredMemoryIds,
      currentMemoryIndexHash,
    });
    if (observation) observations.push(observation);
  }
  return observations;
}

function claudeRetrievalObservations({ events, sourceRunKey, requiredMemoryIds, currentMemoryIndexHash }) {
  const pending = new Map();
  const observations = [];
  for (const event of events ?? []) {
    const content = event?.message?.content ?? event?.content;
    if (!Array.isArray(content)) continue;
    if (event.type === "assistant") {
      for (const item of content) {
        if (item?.type !== "tool_use" || item.name !== "Bash" || !item.id) continue;
        const command = item.input?.command ?? item.input?.cmd ?? item.input;
        if (isMemoryCommand(command)) pending.set(item.id, command);
      }
    }
    if (event.type === "user") {
      for (const item of content) {
        if (item?.type !== "tool_result" || !item.tool_use_id || !pending.has(item.tool_use_id)) continue;
        const observation = observationFromCommand({
          sourceRunKey,
          command: pending.get(item.tool_use_id),
          output: item.content,
          requiredMemoryIds,
          currentMemoryIndexHash,
        });
        if (observation) observations.push(observation);
        pending.delete(item.tool_use_id);
      }
    }
  }
  for (const command of pending.values()) {
    observations.push(
      observationFromCommand({
        sourceRunKey,
        command,
        output: "",
        requiredMemoryIds,
        currentMemoryIndexHash,
      }),
    );
  }
  return observations;
}

function retrievalObservations({ agent, events, sourceRunKey, requiredMemoryIds = [], currentMemoryIndexHash }) {
  if (agent === "claude") {
    return claudeRetrievalObservations({ events, sourceRunKey, requiredMemoryIds, currentMemoryIndexHash });
  }
  return codexRetrievalObservations({ events, sourceRunKey, requiredMemoryIds, currentMemoryIndexHash });
}

export {
  DEFAULT_TOP_K,
  claudeRetrievalObservations,
  codexRetrievalObservations,
  memorySearchDetails,
  retrievalObservations,
};
