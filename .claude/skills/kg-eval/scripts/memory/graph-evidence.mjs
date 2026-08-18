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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactTokenPattern(needle) {
  const normalized = String(needle ?? "").trim();
  if (!normalized) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(normalized)}([^\\p{L}\\p{N}_]|$)`, "iu");
}

function hasExactToken(text, needle) {
  const pattern = exactTokenPattern(needle);
  return pattern ? pattern.test(String(text ?? "")) : false;
}

function negatesEvidence(text, needles) {
  const lower = String(text ?? "").toLocaleLowerCase();
  const negationWords = ["not", "no", "without", "did not", "didn't", "never", "unused", "ignored", "not used", "사용하지", "언급하지"];
  return needles.some((needle) => {
    if (!hasExactToken(lower, needle)) return false;
    const index = lower.search(exactTokenPattern(needle));
    const prefix = lower.slice(Math.max(0, index - 48), index);
    return negationWords.some((word) => prefix.includes(word));
  });
}

function graphEvidenceUsed({ events, graphContext }) {
  if (!graphContext) return null;
  const key = graphContext.source?.key;
  const relationship = graphContext.requiredRelationshipType;
  if (!key || !relationship) return null;
  const texts = eventTexts(events);
  if (texts.length === 0) return null;
  const needles = [key, relationship];
  let positive = false;
  for (const text of texts) {
    if (negatesEvidence(text, needles)) continue;
    if (hasExactToken(text, key) || hasExactToken(text, relationship)) positive = true;
  }
  return positive ? true : null;
}

export { eventTexts, graphEvidenceUsed, hasExactToken };
