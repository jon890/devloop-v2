import path from "node:path";

const AUTOMATIC_MEMORY_CONDITION = "automatic";
const AUTOMATIC_MEMORY_TOP_K = 10;
const CURRENT_SOURCE_PRIORITY_INSTRUCTION =
  "Experience Memory is a clue. If Memory conflicts with the current repository source, the current source is authoritative.";

function assertAutomaticAgentOptions({ agent, agentOptions = {} }) {
  if (agent !== "codex") throw new Error("automatic requires agent=codex");
  if (agentOptions.model !== "gpt-5.6-luna") throw new Error("automatic requires model=gpt-5.6-luna");
  if (agentOptions.effort !== "low") throw new Error("automatic requires effort=low");
}

function automaticMemorySearchArgv({ task, dataDir, devloopRoot, memorySearchArgv }) {
  if (typeof memorySearchArgv !== "function") throw new Error("memorySearchArgv function is required");
  const query = requiredText(task?.oracleQuery, "task.oracleQuery");
  return memorySearchArgv({ query, dataDir, devloopRoot, topK: AUTOMATIC_MEMORY_TOP_K, repository: repositoryDisplayNameFromSourceLock(task), scopePath: automaticScopePath(task) });
}

async function runAutomaticMemorySearch({ task, dataDir, cwd, runMemorySearchFn }) {
  if (typeof runMemorySearchFn !== "function") throw new Error("runMemorySearchFn is required");
  const query = requiredText(task?.oracleQuery, "task.oracleQuery");
  const search = await runMemorySearchFn({
    query,
    dataDir,
    cwd,
    topK: AUTOMATIC_MEMORY_TOP_K,
    repository: repositoryDisplayNameFromSourceLock(task),
    scopePath: automaticScopePath(task),
  });
  if (!search.ok) {
    return {
      ok: false,
      reason: search.reason,
      result: search.result,
      context: automaticContext({ query, results: [], warnings: [{ title: "Memory unavailable", reason: safeReason(search.reason) }] }),
      metrics: automaticMetrics({ memoryCalls: 1 }),
    };
  }
  return buildAutomaticMemoryContext({ task, memory: search.memory, query });
}

function buildAutomaticMemoryContext({ task, memory, query = null }) {
  const effectiveQuery = query ?? requiredText(task?.oracleQuery, "task.oracleQuery");
  const taskRepository = repositoryNameFromSourceLock(task);
  const allowedRevisions = new Set([requiredText(task?.baseRevision, "task.baseRevision").toLowerCase(), requiredText(task?.targetRevision, "task.targetRevision").toLowerCase()]);
  const results = memorySearchResults(memory) ?? [];
  const injected = [];
  const warnings = [];
  let skippedStaleCount = 0;
  let warnedCount = 0;

  for (const item of results) {
    const freshness = memoryFreshness({ item, taskRepository, allowedRevisions });
    const title = itemTitle(item);
    const status = String(item?.status ?? "").toLowerCase();
    const confidence = String(item?.confidence ?? "").toLowerCase();
    const base = { title, freshness: freshness.status, provenance: httpSourceProvenance(item) };

    if (freshness.status === "stale") {
      skippedStaleCount += 1;
      warnings.push({ ...base, reason: "revision-conflict" });
      continue;
    }
    if (freshness.status !== "current") {
      warnedCount += 1;
      warnings.push({ ...base, reason: "confirm-source" });
      continue;
    }
    if (status !== "active") {
      warnedCount += 1;
      warnings.push({ ...base, reason: `status-${safeReason(status || "missing")}` });
      continue;
    }
    if (confidence === "high") {
      const body = itemBody(item);
      if (typeof body !== "string" || body.trim().length === 0) {
        warnedCount += 1;
        warnings.push({ ...base, reason: "missing-body-confirm-source" });
        continue;
      }
      injected.push({
        id: textOrNull(item?.id),
        title,
        body,
      });
      continue;
    }
    if (confidence === "medium") {
      warnedCount += 1;
      warnings.push({ ...base, reason: "medium-confidence-confirm-source" });
      continue;
    }
    warnedCount += 1;
    warnings.push({ ...base, reason: `confidence-${safeReason(confidence || "missing")}` });
  }

  const context = automaticContext({ query: effectiveQuery, results: injected, warnings });
  return {
    ok: true,
    context,
    metrics: automaticMetrics({
      memoryCalls: 1,
      retrievedCount: results.length,
      injectedCount: injected.length,
      warnedCount,
      skippedStaleCount,
      contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
      staleInjectionCount: 0,
    }),
  };
}

function automaticMetrics({
  memoryCalls = 0,
  retrievedCount = 0,
  injectedCount = 0,
  warnedCount = 0,
  skippedStaleCount = 0,
  contextBytes = 0,
  staleInjectionCount = 0,
} = {}) {
  return { memoryCalls, retrievedCount, injectedCount, warnedCount, skippedStaleCount, contextBytes, staleInjectionCount };
}

function automaticContext({ query, results, warnings }) {
  return {
    mode: AUTOMATIC_MEMORY_CONDITION,
    query,
    topK: AUTOMATIC_MEMORY_TOP_K,
    instruction: CURRENT_SOURCE_PRIORITY_INSTRUCTION,
    results,
    warnings,
  };
}

function memoryFreshness({ item, taskRepository, allowedRevisions }) {
  const refs = sourceRefs(item);
  if (refs.length === 0) return { status: "unknown", reason: "missing-git-ref" };
  let hasCurrent = false;
  let sawGit = false;
  let hasDifferentRepository = false;
  let hasRepositoryConflict = false;
  for (const ref of refs) {
    const gitRef = gitRefDetails(ref);
    if (!gitRef) continue;
    if (gitRef.repositoryConflict) {
      hasRepositoryConflict = true;
      continue;
    }
    sawGit = true;
    if (gitRef.repository !== taskRepository) {
      hasDifferentRepository = true;
      continue;
    }
    if (!gitRef.revision || !allowedRevisions.has(gitRef.revision.toLowerCase())) return { status: "stale", reason: "revision-conflict" };
    hasCurrent = true;
  }
  if (hasRepositoryConflict) return { status: "unknown", reason: "repository-conflict" };
  if (hasCurrent) return { status: "current", reason: "matching-revision" };
  if (hasDifferentRepository) return { status: "unknown", reason: "different-repository" };
  return { status: sawGit ? "unknown" : "unknown", reason: "missing-git-ref" };
}

function gitRefDetails(ref) {
  const explicitRepository = canonicalRepositoryName(ref?.repository);
  const urlRepository = repositoryNameFromAnyUrl(ref);
  if (explicitRepository && urlRepository && explicitRepository !== urlRepository) {
    return { repository: explicitRepository, revision: refRevision(ref), repositoryConflict: true };
  }
  const repository = explicitRepository ?? urlRepository;
  const revision = refRevision(ref);
  if (!repository && !revision) return null;
  return { repository, revision };
}

function sourceRefs(item) {
  const refs = [];
  for (const key of ["sourceRefs", "sources", "evidence"]) {
    const value = item?.[key];
    if (Array.isArray(value)) refs.push(...value);
  }
  return refs.filter((ref) => ref && typeof ref === "object");
}

function memorySearchResults(memory) {
  if (Array.isArray(memory?.results)) return memory.results;
  if (Array.isArray(memory?.documents)) return memory.documents;
  if (Array.isArray(memory?.items)) return memory.items;
  return null;
}

function repositoryNameFromSourceLock(task) {
  const repository = repositoryNameFromUrl(requiredText(task?.sourceUrl, "task.sourceUrl"));
  if (!repository) throw new Error("automatic freshness requires sourceUrl with commit or blob repository marker");
  return repository;
}

function repositoryDisplayNameFromSourceLock(task) {
  const repository = repositoryDisplayNameFromUrl(requiredText(task?.sourceUrl, "task.sourceUrl"));
  if (!repository) throw new Error("automatic freshness requires sourceUrl with commit or blob repository marker");
  return repository;
}

function repositoryNameFromAnyUrl(value) {
  for (const key of ["sourceUrl", "url", "href"]) {
    const repository = repositoryNameFromUrl(value?.[key]);
    if (repository) return repository;
  }
  return null;
}

function httpSourceProvenance(item) {
  return sourceRefs(item)
    .map((ref) => {
      const url = httpSourceUrl(ref);
      if (!url) return null;
      return {
        sourceType: textOrNull(ref.sourceType) ?? textOrNull(ref.type) ?? textOrNull(ref.kind) ?? "unknown",
        url,
      };
    })
    .filter(Boolean);
}

function httpSourceUrl(ref) {
  for (const key of ["sourceUrl", "url", "href"]) {
    const value = ref?.[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function repositoryNameFromUrl(value) {
  const displayName = repositoryDisplayNameFromUrl(value);
  return displayName ? canonicalRepositoryName(displayName) : null;
}

function repositoryDisplayNameFromUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const markerIndex = segments.findIndex((segment) => segment === "commit" || segment === "blob");
  if (markerIndex < 1) return null;
  return displayRepositoryName(segments[markerIndex - 1]);
}

function canonicalRepositoryName(value) {
  const displayName = displayRepositoryName(value);
  return displayName ? displayName.toLowerCase() : null;
}

function displayRepositoryName(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  const basename = decoded.split(/[\\/]/).filter(Boolean).at(-1) ?? decoded;
  return basename.replace(/\.git$/i, "");
}

function refRevision(ref) {
  for (const key of ["revision", "commit", "commitHash", "targetRevision", "baseRevision"]) {
    if (typeof ref?.[key] === "string" && ref[key].trim().length > 0) return ref[key].trim();
  }
  for (const key of ["sourceUrl", "url", "href"]) {
    const revision = revisionFromUrl(ref?.[key]);
    if (revision) return revision;
  }
  return null;
}

function revisionFromUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const markerIndex = segments.findIndex((segment) => segment === "commit" || segment === "blob");
  if (markerIndex < 0 || markerIndex + 1 >= segments.length) return null;
  return decodeURIComponent(segments[markerIndex + 1]);
}

function itemTitle(item) {
  return textOrNull(item?.title) ?? textOrNull(item?.id) ?? "untitled Memory";
}

function itemBody(item) {
  return item?.body ?? item?.content ?? item?.text ?? item?.summary;
}

function requiredText(value, field) {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`${field} is required`);
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function safeReason(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 64);
}

function allowedPathScope(task) {
  const allowedPaths = Array.isArray(task?.allowedPaths) ? task.allowedPaths : [];
  if (allowedPaths.length === 0) return ".";
  const parts = allowedPaths.map((item) => String(item).split(/[\\/]/).filter(Boolean));
  const prefix = [];
  for (let index = 0; ; index += 1) {
    const value = parts[0]?.[index];
    if (!value || !parts.every((part) => part[index] === value)) break;
    prefix.push(value);
  }
  return prefix.length === 0 ? "." : path.posix.join(...prefix);
}

function automaticScopePath(task) {
  const scope = allowedPathScope(task);
  return scope === "." ? undefined : scope;
}

export {
  AUTOMATIC_MEMORY_CONDITION,
  AUTOMATIC_MEMORY_TOP_K,
  CURRENT_SOURCE_PRIORITY_INSTRUCTION,
  allowedPathScope,
  assertAutomaticAgentOptions,
  automaticMemorySearchArgv,
  automaticScopePath,
  buildAutomaticMemoryContext,
  memoryFreshness,
  repositoryDisplayNameFromSourceLock,
  repositoryDisplayNameFromUrl,
  repositoryNameFromSourceLock,
  repositoryNameFromUrl,
  runAutomaticMemorySearch,
};
