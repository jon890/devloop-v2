import { readFile } from "node:fs/promises";
import { canonicalHash, hasText } from "./suite.mjs";

function nowMs() {
  return Date.now();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sanitizeNode(node, { includeKeyDisplay = false } = {}) {
  return {
    id: node.id,
    label: node.label,
    ...(includeKeyDisplay ? { key: node.key, display: node.display } : {}),
  };
}

function sanitizeRelationship(relationship) {
  return {
    id: relationship.id,
    type: relationship.type,
    startId: relationship.startId,
    endId: relationship.endId,
  };
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return value;
}

function validateEvidence(value, label) {
  const object = requireObject(value, label);
  if (!Array.isArray(object.nodes)) throw new Error(`${label}.nodes: expected array`);
  if (!Array.isArray(object.relationships)) throw new Error(`${label}.relationships: expected array`);
  for (const [index, node] of object.nodes.entries()) {
    requireObject(node, `${label}.nodes[${index}]`);
    for (const field of ["id", "label", "key", "display"]) {
      if (!hasText(node[field])) throw new Error(`${label}.nodes[${index}].${field}: expected non-empty string`);
    }
  }
  for (const [index, relationship] of object.relationships.entries()) {
    requireObject(relationship, `${label}.relationships[${index}]`);
    for (const field of ["id", "type", "startId", "endId"]) {
      if (!hasText(relationship[field])) throw new Error(`${label}.relationships[${index}].${field}: expected non-empty string`);
    }
  }
  return object;
}

function validateStats(value) {
  const object = requireObject(value, "stats");
  for (const field of ["nodes", "relationships"]) {
    const record = requireObject(object[field], `stats.${field}`);
    for (const [key, count] of Object.entries(record)) {
      if (!hasText(key) || !Number.isInteger(count) || count < 0) {
        throw new Error(`stats.${field}.${key}: expected non-negative integer`);
      }
    }
  }
  return object;
}

function validateSamples(value) {
  const object = validateEvidence(value, "samples");
  for (const field of ["total", "offset", "limit"]) {
    if (!Number.isInteger(object[field]) || object[field] < 0) throw new Error(`samples.${field}: expected non-negative integer`);
  }
  if (object.limit < 1) throw new Error("samples.limit: expected positive integer");
  return object;
}

function apiUrl(baseUrl, pathname, params = {}) {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchJson(fetchFn, url) {
  const response = await fetchFn(url);
  if (!response.ok) {
    const error = new Error(`Graph HTTP ${response.status}`);
    error.safeCode = `GRAPH_HTTP_${response.status}`;
    throw error;
  }
  return response.json();
}

async function timedFetchJson(fetchFn, url, metrics) {
  const startedAt = nowMs();
  try {
    return await fetchJson(fetchFn, url);
  } finally {
    metrics.graphContextCalls += 1;
    metrics.graphLatencyMs += nowMs() - startedAt;
  }
}

function lockTask(graphLock, taskId) {
  const task = graphLock.tasks?.find((item) => item.taskId === taskId);
  if (!task) throw new Error(`${taskId}: missing from graph lock`);
  return task;
}

async function resolveExactSample({ fetchFn, graphBaseUrl, label, key, metrics }) {
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = validateSamples(await timedFetchJson(fetchFn, apiUrl(graphBaseUrl, "/api/graph/samples", { label, offset, limit }), metrics));
    const matched = page.nodes.find((node) => node.label === label && node.key === key);
    if (matched) return { matched, page };
    if (page.offset + page.limit >= page.total) break;
  }
  throw new Error(`Graph anchor sample not found by exact ${label}.${key}`);
}

function graphPromptContext({ lockTask, neighbors }) {
  const relationshipTypes = [...new Set(neighbors.relationships.map((relationship) => relationship.type))].sort();
  return {
    source: {
      key: lockTask.key,
      label: lockTask.label,
      sourceUrl: lockTask.sourceRef.sourceUrl,
      targetRevision: lockTask.sourceRef.targetRevision,
    },
    requiredRelationshipType: lockTask.requiredRelationshipType,
    relationshipTypes,
    neighborSummary: {
      depth: lockTask.depth,
      nodeCount: neighbors.nodes.length,
      relationshipCount: neighbors.relationships.length,
    },
  };
}

async function buildGraphContext({ graphLockPath, graphBaseUrl, taskId, fetchFn = globalThis.fetch }) {
  if (typeof fetchFn !== "function") throw new Error("fetch is unavailable");
  const graphLock = await readJson(graphLockPath);
  const task = lockTask(graphLock, taskId);
  const metrics = { graphContextCalls: 0, graphLatencyMs: 0 };
  try {
    const stats = validateStats(await timedFetchJson(fetchFn, apiUrl(graphBaseUrl, "/api/graph/stats"), metrics));
    const graphStatsHash = `sha256:${canonicalHash(stats)}`;
    if (graphStatsHash !== graphLock.graphStatsHash) {
      const error = new Error(`Graph stats hash changed: ${graphStatsHash} !== ${graphLock.graphStatsHash}`);
      error.safeCode = "GRAPH_STATS_HASH_CHANGED";
      throw error;
    }
    const { matched, page } = await resolveExactSample({ fetchFn, graphBaseUrl, label: task.label, key: task.key, metrics });
    if (matched.id !== task.resolvedElementId) {
      const error = new Error(`Graph anchor elementId changed for ${taskId}: ${matched.id} !== ${task.resolvedElementId}`);
      error.safeCode = "GRAPH_ANCHOR_CHANGED";
      throw error;
    }
    const neighbors = validateEvidence(
      await timedFetchJson(fetchFn, apiUrl(graphBaseUrl, `/api/graph/nodes/${encodeURIComponent(matched.id)}/neighbors`, { depth: task.depth }), metrics),
      "neighbors",
    );
    if (!neighbors.relationships.some((relationship) => relationship.type === task.requiredRelationshipType)) {
      const error = new Error(`Graph anchor is missing required relationship ${task.requiredRelationshipType}`);
      error.safeCode = "GRAPH_RELATIONSHIP_MISSING";
      throw error;
    }
    return {
      context: graphPromptContext({ lockTask: task, neighbors }),
      evidence: {
        resolvedElementId: matched.id,
        graphStatsHash,
        samplePage: {
          label: task.label,
          offset: page.offset,
          limit: page.limit,
          total: page.total,
          matchedNode: sanitizeNode(matched, { includeKeyDisplay: true }),
        },
        neighbors: {
          depth: task.depth,
          nodes: neighbors.nodes.map((node) => sanitizeNode(node, { includeKeyDisplay: node.id === matched.id })),
          relationships: neighbors.relationships.map(sanitizeRelationship),
        },
      },
      metrics,
    };
  } catch (error) {
    if (error instanceof Error) error.metrics = metrics;
    throw error;
  }
}

export { buildGraphContext, graphPromptContext, validateEvidence, validateSamples, validateStats };
