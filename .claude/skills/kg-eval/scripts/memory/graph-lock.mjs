import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { loadMemoryEvaluationInputs } from "../validate-memory-suite.mjs";
import { canonicalHash } from "./suite.mjs";
import { resolveSourceRepositoryRoot } from "./source-repository-root.mjs";

const DEFAULT_OUT = "eval/runs/plan016-graph-lock.json";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:3016";
const DEFAULT_EXPECTED_MEMORY_INDEX_HASH = "sha256:8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd";
const LOCK_SCHEMA_VERSION = "memory-graph-lock/v1";
const SELECTED_TASKS = [
  {
    taskId: "MEM-EXP-001",
    taskType: "relationship-heavy",
    label: "Concept",
    key: "LB",
    depth: 1,
    requiredRelationshipType: "MENTIONS",
    sourceTextKind: "message",
  },
  {
    taskId: "MEM-EXP-002",
    taskType: "general",
    label: "Concept",
    key: "cab api",
    depth: 1,
    requiredRelationshipType: "MENTIONS",
    sourceTextKind: "message",
  },
];

function usage() {
  return `Usage: node .claude/skills/kg-eval/scripts/memory/graph-lock.mjs --suite <suite.json> --source-lock <lock.json> --plan014-run <run.json> --source-repository-root <root> [options]

Options:
  --out <path>                 Graph lock path (default: ${DEFAULT_OUT})
  --api-base-url <url>         Graph API base URL (default: ${DEFAULT_API_BASE_URL})
  --expected-memory-index-hash <hash>
                               Expected plan014 Memory index hash (default: ${DEFAULT_EXPECTED_MEMORY_INDEX_HASH})
  --help                       Show this help
`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set(["--suite", "--source-lock", "--plan014-run", "--source-repository-root", "--out", "--api-base-url", "--expected-memory-index-hash"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    args[arg.slice(2)] = value;
    index += 1;
  }
  for (const required of ["suite", "source-lock", "plan014-run", "source-repository-root"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return {
    suitePath: args.suite,
    sourceLockPath: args["source-lock"],
    plan014RunPath: args["plan014-run"],
    sourceRepositoryRoot: args["source-repository-root"],
    outPath: args.out ?? DEFAULT_OUT,
    apiBaseUrl: args["api-base-url"] ?? DEFAULT_API_BASE_URL,
    expectedMemoryIndexHash: args["expected-memory-index-hash"] ?? DEFAULT_EXPECTED_MEMORY_INDEX_HASH,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function commitSubjectBody(repositoryPath, revision) {
  const subject = await runGit(["-C", repositoryPath, "show", "--no-patch", "--format=%s", revision], process.cwd());
  if (subject.status !== 0) throw new Error(`git show subject failed for ${revision}: ${subject.stderr.trim()}`);
  const body = await runGit(["-C", repositoryPath, "show", "--no-patch", "--format=%b", revision], process.cwd());
  if (body.status !== 0) throw new Error(`git show body failed for ${revision}: ${body.stderr.trim()}`);
  return { subject: subject.stdout.trim(), body: body.stdout.trim() };
}

function containsConcept(text, concept) {
  return String(text ?? "").toLocaleLowerCase().includes(concept.toLocaleLowerCase());
}

function matchedCommitFields(commit, concept) {
  return ["subject", "body"].filter((field) => containsConcept(commit[field], concept));
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

function encodeQuery(params) {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
}

async function fetchJson(fetchFn, url) {
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function findSampleNode({ fetchFn, apiBaseUrl, label, key }) {
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await fetchJson(fetchFn, `${apiBaseUrl}/api/graph/samples?${encodeQuery({ label, offset, limit })}`);
    const matched = page.nodes.find((node) => node.label === label && node.key === key);
    if (matched) {
      return {
        node: matched,
        samplePage: {
          label,
          offset: page.offset,
          limit: page.limit,
          total: page.total,
          matchedNode: sanitizeNode(matched, { includeKeyDisplay: true }),
          nodes: page.nodes.map((node) => sanitizeNode(node)),
          relationships: page.relationships.map(sanitizeRelationship),
        },
      };
    }
    if (page.offset + page.limit >= page.total) break;
  }
  throw new Error(`Graph anchor sample not found by exact ${label}.${key}`);
}

async function validatedNeighbors({ fetchFn, apiBaseUrl, nodeId, depth, requiredRelationshipType }) {
  const neighbors = await fetchJson(fetchFn, `${apiBaseUrl}/api/graph/nodes/${encodeURIComponent(nodeId)}/neighbors?${encodeQuery({ depth })}`);
  if (!neighbors.relationships.some((relationship) => relationship.type === requiredRelationshipType)) {
    throw new Error(`Graph anchor is missing required relationship ${requiredRelationshipType}`);
  }
  return {
    depth,
    nodes: neighbors.nodes.map((node) => sanitizeNode(node, { includeKeyDisplay: node.id === nodeId })),
    relationships: neighbors.relationships.map(sanitizeRelationship),
  };
}

async function validateSearch({ fetchFn, apiBaseUrl, key, resolvedElementId }) {
  const search = await fetchJson(fetchFn, `${apiBaseUrl}/api/graph/search?${encodeQuery({ q: key })}`);
  return {
    q: key,
    foundResolvedElementId: search.some((node) => node.id === resolvedElementId),
    nodes: search.map((node) => sanitizeNode(node, { includeKeyDisplay: node.id === resolvedElementId })),
  };
}

function selectedPublicTask(suite, taskId) {
  const task = suite.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`${taskId}: missing from public suite`);
  if (task.category !== "experience-needed") throw new Error(`${taskId}: must be category=experience-needed`);
  return task;
}

function assertSelectedTaskShape(suite) {
  const exp001 = selectedPublicTask(suite, "MEM-EXP-001");
  const exp002 = selectedPublicTask(suite, "MEM-EXP-002");
  if (!exp001.tags.includes("relationship-heavy")) throw new Error("MEM-EXP-001 must be tagged relationship-heavy");
  if (exp002.tags.includes("relationship-heavy")) throw new Error("MEM-EXP-002 must not be tagged relationship-heavy");
}

function sourceUrlMatches(task) {
  try {
    const url = new URL(task.sourceUrl);
    return url.pathname.endsWith(`/commit/${task.targetRevision}`);
  } catch {
    return false;
  }
}

function validatePlan014Baseline({ plan014Run, suiteHash, sourceLockHash, expectedMemoryIndexHash }) {
  if (plan014Run.suiteHash !== suiteHash) {
    throw new Error(`plan014 suiteHash mismatch: ${plan014Run.suiteHash} !== ${suiteHash}`);
  }
  if (plan014Run.sourceLockHash !== sourceLockHash) {
    throw new Error(`plan014 sourceLockHash mismatch: ${plan014Run.sourceLockHash} !== ${sourceLockHash}`);
  }
  if (plan014Run.memoryIndexHash !== expectedMemoryIndexHash) {
    throw new Error(`plan014 memoryIndexHash mismatch: ${plan014Run.memoryIndexHash} !== ${expectedMemoryIndexHash}`);
  }
  const conditions = plan014Run.executionPlan?.conditions;
  if (
    !Array.isArray(conditions) ||
    JSON.stringify(conditions) !== JSON.stringify(["no-memory", "agent-triggered", "oracle-memory"]) ||
    plan014Run.executionPlan?.repeats !== 3
  ) {
    throw new Error("plan014 executionPlan must use no-memory, agent-triggered, oracle-memory with repeats=3");
  }
  return Object.fromEntries(SELECTED_TASKS.map((task) => [task.taskId, plan014RunKeys(plan014Run, task.taskId)]));
}

function plan014RunKeys(plan014Run, taskId) {
  const keys = [];
  const requiredKeys = new Set();
  for (const condition of ["no-memory", "oracle-memory"]) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      requiredKeys.add(`${taskId}:${condition}:${repetition}`);
      const attempt = plan014Run.attempts.find((item) => item.taskId === taskId && item.condition === condition && item.repetition === repetition);
      if (!attempt) throw new Error(`${taskId}:${condition}:${repetition}: missing plan014 attempt`);
      if (attempt.validationStatus !== 0) throw new Error(`${taskId}:${condition}:${repetition}: validationStatus must be 0`);
      if (attempt.taskSuccess !== true) throw new Error(`${taskId}:${condition}:${repetition}: taskSuccess must be true`);
      keys.push({
        sourceRunKey: `${taskId}:${condition}:${repetition}`,
        taskId,
        condition,
        repetition,
        validationStatus: attempt.validationStatus,
        taskSuccess: attempt.taskSuccess,
        workspaceDiffHash: attempt.workspaceDiffHash,
        memoryIndexHash: plan014Run.memoryIndexHash,
      });
    }
  }
  if (keys.length !== requiredKeys.size || keys.length !== 6) {
    throw new Error(`${taskId}: expected exactly 6 selected plan014 baseline attempts`);
  }
  return keys;
}

async function buildGraphLock(options) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("global fetch is unavailable");
  const inputs = await loadMemoryEvaluationInputs({ suitePath: options.suitePath, sourceLockPath: options.sourceLockPath });
  assertSelectedTaskShape(inputs.suite);
  const plan014Run = await readJson(options.plan014RunPath);
  const baselineRunKeys = validatePlan014Baseline({
    plan014Run,
    suiteHash: inputs.suiteHash,
    sourceLockHash: inputs.sourceLockHash,
    expectedMemoryIndexHash: options.expectedMemoryIndexHash ?? DEFAULT_EXPECTED_MEMORY_INDEX_HASH,
  });
  const selectedTaskIds = new Set(SELECTED_TASKS.map((task) => task.taskId));
  const selectedSourceTasks = inputs.sourceLock.tasks.filter((task) => selectedTaskIds.has(task.taskId));
  const resolution = await resolveSourceRepositoryRoot({ sourceRepositoryRoot: options.sourceRepositoryRoot, tasks: selectedSourceTasks });
  const resolvedByTaskId = new Map(resolution.tasks.map((task) => [task.taskId, task]));
  const stats = await fetchJson(fetchFn, `${options.apiBaseUrl}/api/graph/stats`);
  const graphStatsHash = `sha256:${canonicalHash(stats)}`;
  const tasks = [];
  for (const anchor of SELECTED_TASKS) {
    const sourceTask = resolvedByTaskId.get(anchor.taskId);
    if (!sourceTask) throw new Error(`${anchor.taskId}: missing source lock task`);
    if (!sourceUrlMatches(sourceTask)) throw new Error(`${anchor.taskId}: sourceUrl must exact-match target revision commit URL`);
    const commit = await commitSubjectBody(sourceTask.repositoryPath, sourceTask.targetRevision);
    const sourceMatchedFields = matchedCommitFields(commit, anchor.key);
    if (sourceMatchedFields.length === 0 || !containsConcept(sourceTask.oracleQuery, anchor.key)) {
      throw new Error(`${anchor.taskId}: anchor concept is not present in source commit message and oracleQuery`);
    }
    const { node, samplePage } = await findSampleNode({ fetchFn, apiBaseUrl: options.apiBaseUrl, label: anchor.label, key: anchor.key });
    const neighbors = await validatedNeighbors({
      fetchFn,
      apiBaseUrl: options.apiBaseUrl,
      nodeId: node.id,
      depth: anchor.depth,
      requiredRelationshipType: anchor.requiredRelationshipType,
    });
    tasks.push({
      taskId: anchor.taskId,
      taskType: anchor.taskType,
      sourceRef: {
        sourceUrl: sourceTask.sourceUrl,
        repositoryBasename: path.basename(sourceTask.originalRepositoryPath),
        targetRevision: sourceTask.targetRevision,
      },
      label: anchor.label,
      key: anchor.key,
      resolvedElementId: node.id,
      depth: anchor.depth,
      requiredRelationshipType: anchor.requiredRelationshipType,
      sourceTextKind: anchor.sourceTextKind,
      sourceMatchedFields,
      sourceRepositoryResolution: sourceTask.sourceRepositoryResolution,
      plan014RunKeys: baselineRunKeys[anchor.taskId],
      samplePage,
      searchCheck: await validateSearch({ fetchFn, apiBaseUrl: options.apiBaseUrl, key: anchor.key, resolvedElementId: node.id }),
      neighbors,
    });
  }
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    suitePath: options.suitePath,
    sourceLockPath: options.sourceLockPath,
    plan014RunPath: options.plan014RunPath,
    suiteHash: inputs.suiteHash,
    sourceLockHash: inputs.sourceLockHash,
    memoryIndexHash: plan014Run.memoryIndexHash,
    plan014RunIdentity: {
      schemaVersion: plan014Run.schemaVersion,
      sourceLockHash: plan014Run.sourceLockHash,
      suiteHash: plan014Run.suiteHash,
      executionPlan: plan014Run.executionPlan,
      agent: plan014Run.agent,
      agentOptions: plan014Run.agentOptions,
    },
    apiBaseUrl: options.apiBaseUrl,
    graphStatsSchema: "GraphStatsResponse",
    graphStats: stats,
    graphStatsHash,
    tasks,
  };
}

async function writeGraphLock(options) {
  const lock = await buildGraphLock(options);
  await mkdir(path.dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const lock = await writeGraphLock(options);
    process.stdout.write(`${JSON.stringify({ outPath: options.outPath, taskCount: lock.tasks.length, graphStatsHash: lock.graphStatsHash })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export {
  LOCK_SCHEMA_VERSION,
  buildGraphLock,
  containsConcept,
  findSampleNode,
  parseArgs,
  plan014RunKeys,
  sanitizeNode,
  sanitizeRelationship,
  usage,
  validatePlan014Baseline,
  writeGraphLock,
};
