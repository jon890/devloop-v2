import path from "node:path";

function normalizePath(filePath) {
  return path.posix.normalize(String(filePath).replaceAll("\\", "/"));
}

function isAllowedPath(filePath, allowedPaths) {
  const normalized = normalizePath(filePath);
  return allowedPaths.some((allowedPath) => {
    const allowed = normalizePath(allowedPath);
    return normalized === allowed || normalized.startsWith(`${allowed.replace(/\/+$/, "")}/`);
  });
}

function changedPathsFromDiff(diff) {
  const paths = new Set();
  for (const line of String(diff ?? "").split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      paths.add(match[2]);
    }
  }
  return [...paths];
}

function countReworkEvents(events) {
  return (events ?? []).filter((event) => {
    const type = typeof event === "string" ? event : event?.type;
    return type === "validation-failed" || type === "wrong-edit-detected" || type === "rework";
  }).length;
}

function judgeMemoryAttempt({ validationResult, allowedPaths, diff, events = [] }) {
  const changedPaths = Array.isArray(diff?.changedPaths) ? diff.changedPaths : changedPathsFromDiff(diff?.patch ?? diff);
  const wrongEditPaths = changedPaths.filter((changedPath) => !isAllowedPath(changedPath, allowedPaths ?? []));
  const validationPassed = validationResult?.status === 0 || validationResult?.ok === true || validationResult?.passed === true;
  return {
    taskSuccess: Boolean(validationPassed && wrongEditPaths.length === 0),
    wrongEditCount: wrongEditPaths.length,
    wrongEditPaths,
    reworkCount: countReworkEvents(events),
  };
}

export { changedPathsFromDiff, isAllowedPath, judgeMemoryAttempt };
