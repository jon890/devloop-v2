const SOURCE_READ_COMMANDS = new Set(["cat", "sed", "rg", "grep", "head", "tail", "nl", "ls", "find"]);
const SOURCE_READ_GIT_SUBCOMMANDS = new Set(["show", "diff", "grep", "ls-files"]);
const SOURCE_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

function parseJsonl(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function commandText(command) {
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string") return command;
  if (Array.isArray(command?.argv)) return command.argv.join(" ");
  if (typeof command?.command === "string") return command.command;
  return "";
}

function firstWord(command) {
  return commandText(command).trim().split(/\s+/)[0] ?? "";
}

function isMemoryCommand(command) {
  const text = commandText(command);
  return /^\s*(pnpm\s+(--silent\s+)?)?memory-search(\s|$)/.test(text) || /^\s*(node\s+)?dist\/memory\/cli\.js\s+search(\s|$)/.test(text);
}

function isGraphCommand(command) {
  const text = commandText(command);
  return /\/api\/graph|neo4j|cypher|resolve-graph|sync-neo4j/.test(text);
}

function isSourceReadCommand(command) {
  const parts = commandText(command).trim().split(/\s+/);
  if (SOURCE_READ_COMMANDS.has(parts[0])) return true;
  return parts[0] === "git" && SOURCE_READ_GIT_SUBCOMMANDS.has(parts[1]);
}

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens;
  return {
    inputTokens: Number.isFinite(input) ? input : null,
    outputTokens: Number.isFinite(output) ? output : null,
  };
}

function emptyTelemetry() {
  return {
    turns: 0,
    toolCalls: 0,
    sourceReads: 0,
    memoryCalls: 0,
    graphCalls: 0,
    inputTokens: null,
    outputTokens: null,
    reworkCount: 0,
  };
}

function addUsage(telemetry, usage) {
  const tokens = usageTokens(usage);
  if (!tokens) return;
  telemetry.inputTokens = (telemetry.inputTokens ?? 0) + (tokens.inputTokens ?? 0);
  telemetry.outputTokens = (telemetry.outputTokens ?? 0) + (tokens.outputTokens ?? 0);
}

function observeCommand(telemetry, command) {
  telemetry.toolCalls += 1;
  if (isSourceReadCommand(command)) telemetry.sourceReads += 1;
  if (isMemoryCommand(command)) telemetry.memoryCalls += 1;
  if (isGraphCommand(command)) telemetry.graphCalls += 1;
}

function observeClaudeContent(telemetry, content) {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (item?.type !== "tool_use") continue;
    telemetry.toolCalls += 1;
    const toolName = item.name ?? "";
    const input = item.input ?? {};
    const command = input.command ?? input.cmd ?? input;
    if (SOURCE_READ_TOOLS.has(toolName) || (toolName === "Bash" && isSourceReadCommand(command))) telemetry.sourceReads += 1;
    if (toolName === "Bash" && isMemoryCommand(command)) telemetry.memoryCalls += 1;
    if (toolName === "Bash" && isGraphCommand(command)) telemetry.graphCalls += 1;
  }
}

function normalizeAgentTelemetry(events) {
  const telemetry = emptyTelemetry();
  for (const event of events ?? []) {
    if (event?.type === "turn.completed") {
      telemetry.turns += 1;
      addUsage(telemetry, event.usage);
    }
    if (event?.type === "item.completed" && event.item?.type === "command_execution") {
      observeCommand(telemetry, event.item.command ?? event.item.argv ?? event.item);
    }
    if (event?.type === "assistant") {
      telemetry.turns += 1;
      observeClaudeContent(telemetry, event.message?.content ?? event.content);
    }
    if (event?.type === "result") {
      addUsage(telemetry, event.usage);
    }
    if (event?.type === "validation-failed" || event?.type === "wrong-edit-detected" || event?.type === "rework") {
      telemetry.reworkCount += 1;
    }
  }
  return telemetry;
}

function normalizeAgentTelemetryJsonl(text) {
  return normalizeAgentTelemetry(parseJsonl(text));
}

export {
  isGraphCommand,
  isMemoryCommand,
  isSourceReadCommand,
  normalizeAgentTelemetry,
  normalizeAgentTelemetryJsonl,
  parseJsonl,
};
