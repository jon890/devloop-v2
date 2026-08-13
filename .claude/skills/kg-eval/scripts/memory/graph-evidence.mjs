function commandText(command) {
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string") return command;
  if (Array.isArray(command?.argv)) return command.argv.join(" ");
  if (typeof command?.command === "string") return command.command;
  return "";
}

function eventTexts(events) {
  const texts = [];
  for (const event of events ?? []) {
    if (event?.type === "item.completed" && event.item?.type === "command_execution") {
      texts.push(commandText(event.item.command ?? event.item.argv ?? event.item));
    }
    for (const field of ["message", "content", "text", "stdout", "stderr"]) {
      const value = event?.[field];
      if (typeof value === "string") texts.push(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") texts.push(item);
          if (typeof item?.text === "string") texts.push(item.text);
          if (typeof item?.content === "string") texts.push(item.content);
        }
      }
    }
  }
  return texts;
}

function includesText(haystack, needle) {
  return String(haystack ?? "").toLocaleLowerCase().includes(String(needle ?? "").toLocaleLowerCase());
}

function graphEvidenceUsed({ events, graphContext }) {
  if (!graphContext) return null;
  const key = graphContext.source?.key;
  const relationship = graphContext.requiredRelationshipType;
  if (!key || !relationship) return null;
  const texts = eventTexts(events);
  if (texts.length === 0) return null;
  return texts.some((text) => includesText(text, key) || includesText(text, relationship));
}

export { eventTexts, graphEvidenceUsed };
