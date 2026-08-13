#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPORT_SCHEMA_VERSION = "memory-retrieval-report/v1";
const NO_CHANGE_LIMITS = [
  "No lexical retrieval misses were present in the input, so adapter comparison was not run.",
  "This report does not evaluate pretrained semantic retrieval quality.",
  "No production backend, vector database, or adapter implementation was changed.",
];

function usage() {
  return `Usage: node .claude/skills/kg-eval/scripts/report-memory-retrieval.mjs --misses <misses.json> --json-out <report.json> --markdown-out <report.md> [--comparison <comparison.json>]\n`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set(["--misses", "--comparison", "--json-out", "--markdown-out"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  for (const required of ["misses", "json-out", "markdown-out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return {
    missesPath: args.misses,
    comparisonPath: args.comparison ?? null,
    jsonOutPath: args["json-out"],
    markdownOutPath: args["markdown-out"],
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function validateMissLock(missLock) {
  if (!isPlainObject(missLock)) throw new Error("PHASE_BLOCKED: retrieval miss input invalid");
  if (missLock.schemaVersion !== "memory-retrieval-miss-lock/v1") {
    throw new Error("PHASE_BLOCKED: retrieval miss input invalid: schemaVersion");
  }
  if (!Number.isInteger(missLock.missCount) || missLock.missCount < 0) {
    throw new Error("PHASE_BLOCKED: retrieval miss input invalid: missCount");
  }
  if (!Array.isArray(missLock.misses) || missLock.misses.length !== missLock.missCount) {
    throw new Error("PHASE_BLOCKED: retrieval miss input invalid: miss count mismatch");
  }
  if (missLock.retrievalObservationComplete !== true) {
    throw new Error("PHASE_BLOCKED: retrieval miss input invalid: observation incomplete");
  }
  if (typeof missLock.memoryIndexHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(missLock.memoryIndexHash)) {
    throw new Error("PHASE_BLOCKED: retrieval miss input invalid: memoryIndexHash");
  }
}

function validateNoPrivateMissText(report) {
  const text = canonicalBytes(report);
  if (/private query/i.test(text) || /mem-required|mem-other/i.test(text)) {
    throw new Error("PHASE_BLOCKED: public retrieval report includes private miss content");
  }
}

function comparisonAdapters(comparison) {
  if (Array.isArray(comparison?.adapters)) return comparison.adapters;
  if (Array.isArray(comparison?.adapterResults)) return comparison.adapterResults;
  if (Array.isArray(comparison?.results)) return comparison.results;
  return [];
}

function adapterName(adapter) {
  return adapter.adapter ?? adapter.name ?? adapter.id ?? null;
}

function adapterMissCount(adapter) {
  if (Number.isInteger(adapter.missCount)) return adapter.missCount;
  if (Array.isArray(adapter.misses)) return adapter.misses.length;
  if (Number.isInteger(adapter.queryCount)) return adapter.queryCount;
  return null;
}

function metric(adapter, ...names) {
  for (const name of names) {
    if (Number.isFinite(adapter[name])) return adapter[name];
    if (Number.isFinite(adapter.metrics?.[name])) return adapter.metrics[name];
    if (Number.isFinite(adapter.cost?.[name])) return adapter.cost[name];
  }
  return null;
}

function validateComparison({ missLock, comparison, comparisonBytes }) {
  const adapters = comparisonAdapters(comparison);
  if (adapters.length !== 3) {
    throw new Error("PHASE_BLOCKED: retrieval comparison input incomplete: expected 3 adapters");
  }
  const names = adapters.map(adapterName).sort();
  if (names.join(",") !== "hybrid,lexical,sqlite") {
    throw new Error("PHASE_BLOCKED: retrieval comparison input incomplete: expected lexical/sqlite/hybrid adapters");
  }
  const corpusHashes = new Set(adapters.map((adapter) => adapter.memoryIndexHash ?? adapter.corpusHash ?? adapter.corpus?.hash ?? null));
  if (corpusHashes.size !== 1 || !corpusHashes.has(missLock.memoryIndexHash)) {
    throw new Error("PHASE_BLOCKED: retrieval 비교 조건 불일치");
  }
  const topKs = new Set(adapters.map((adapter) => adapter.topK ?? adapter.parameters?.topK ?? null));
  const missTopKs = new Set(missLock.misses.map((miss) => miss.topK));
  if (topKs.size !== 1 || missTopKs.size !== 1 || !topKs.has([...missTopKs][0])) {
    throw new Error("PHASE_BLOCKED: retrieval 비교 조건 불일치");
  }
  for (const adapter of adapters) {
    if (adapterMissCount(adapter) !== missLock.missCount) {
      throw new Error("PHASE_BLOCKED: retrieval comparison input incomplete: miss count mismatch");
    }
  }
  return {
    comparisonHash: sha256Hex(comparisonBytes),
    adapters: adapters
      .map((adapter) => ({
        adapter: adapterName(adapter),
        topK: adapter.topK ?? adapter.parameters?.topK,
        corpusHash: adapter.memoryIndexHash ?? adapter.corpusHash ?? adapter.corpus?.hash,
        queryCount: adapterMissCount(adapter),
        recallAtK: metric(adapter, "recallAtK", "recall"),
        searchLatencyMsMedian: metric(adapter, "searchLatencyMsMedian", "searchLatencyMs"),
        buildTimeMs: metric(adapter, "buildTimeMs"),
        indexSizeBytes: metric(adapter, "indexSizeBytes"),
        rssDeltaBytes: metric(adapter, "rssDeltaBytes"),
        dependencyCount: metric(adapter, "dependencyCount"),
        serviceCount: metric(adapter, "serviceCount"),
      }))
      .sort((left, right) => left.adapter.localeCompare(right.adapter)),
  };
}

async function buildRetrievalReport({ missesPath, comparisonPath }) {
  const missText = await readFile(missesPath, "utf8");
  const missLock = JSON.parse(missText);
  validateMissLock(missLock);
  const base = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: null,
    source: {
      missLockHash: sha256Hex(missText),
      sourceRunHash: missLock.sourceRunHash ?? null,
      suiteHash: missLock.suiteHash ?? null,
      memoryIndexHash: missLock.memoryIndexHash ?? null,
    },
    decision: null,
    missCount: missLock.missCount,
    adaptersEvaluated: 0,
    comparisonHash: null,
    retrievalObservationComplete: missLock.retrievalObservationComplete === true,
    limits: NO_CHANGE_LIMITS,
    adapters: [],
  };
  if (missLock.missCount === 0) {
    const report = { ...base, decision: "NO_CHANGE" };
    validateNoPrivateMissText(report);
    return report;
  }
  if (!comparisonPath || !(await exists(comparisonPath))) {
    throw new Error("PHASE_BLOCKED: retrieval comparison input missing for non-zero missCount");
  }
  const comparisonBytes = await readFile(comparisonPath, "utf8");
  const comparison = JSON.parse(comparisonBytes);
  const compared = validateComparison({ missLock, comparison, comparisonBytes });
  const report = {
    ...base,
    decision: "INCONCLUSIVE",
    adaptersEvaluated: compared.adapters.length,
    comparisonHash: compared.comparisonHash,
    limits: [
      "Local TF-IDF hybrid is not a pretrained semantic model.",
      "Decision requires enough miss queries, repeated runs, and stable cost measurements.",
      "No production backend, vector database, or adapter implementation was changed.",
    ],
    adapters: compared.adapters,
  };
  validateNoPrivateMissText(report);
  return report;
}

function markdownValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return String(value);
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => markdownValue(row[header])).join(" | ")} |`),
  ].join("\n");
}

function renderMarkdown(report) {
  const hashRows = [
    { Key: "Miss lock hash", Value: `\`${report.source.missLockHash}\`` },
    { Key: "Source run hash", Value: report.source.sourceRunHash ? `\`${report.source.sourceRunHash}\`` : "null" },
    { Key: "Suite hash", Value: report.source.suiteHash ? `\`${report.source.suiteHash}\`` : "null" },
    { Key: "Memory index hash", Value: report.source.memoryIndexHash ? `\`${report.source.memoryIndexHash}\`` : "null" },
    { Key: "Comparison hash", Value: report.comparisonHash ? `\`${report.comparisonHash}\`` : "null" },
  ];
  const summaryRows = [
    {
      Decision: report.decision,
      Misses: report.missCount,
      Adapters: report.adaptersEvaluated,
      Complete: report.retrievalObservationComplete,
    },
  ];
  const sections = [
    "# Plan015 Memory Retrieval Report",
    "",
    "## Summary",
    "",
    markdownTable(["Decision", "Misses", "Adapters", "Complete"], summaryRows),
    "",
    "## Hashes",
    "",
    markdownTable(["Key", "Value"], hashRows),
    "",
    "## Limits",
    "",
    ...report.limits.map((item) => `- ${item}`),
    "",
  ];
  if (report.adapters.length > 0) {
    sections.push(
      "## Adapter Results",
      "",
      markdownTable(
        ["Adapter", "TopK", "QueryCount", "RecallAtK", "LatencyMs", "BuildMs", "IndexBytes", "RssBytes", "Dependencies", "Services"],
        report.adapters.map((adapter) => ({
          Adapter: adapter.adapter,
          TopK: adapter.topK,
          QueryCount: adapter.queryCount,
          RecallAtK: adapter.recallAtK,
          LatencyMs: adapter.searchLatencyMsMedian,
          BuildMs: adapter.buildTimeMs,
          IndexBytes: adapter.indexSizeBytes,
          RssBytes: adapter.rssDeltaBytes,
          Dependencies: adapter.dependencyCount,
          Services: adapter.serviceCount,
        })),
      ),
      "",
    );
  }
  return `${sections.join("\n")}`;
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const report = await buildRetrievalReport(options);
    await writeText(options.jsonOutPath, canonicalBytes(report));
    await writeText(options.markdownOutPath, renderMarkdown(report));
    process.stdout.write(`${JSON.stringify({ decision: report.decision, missCount: report.missCount, adaptersEvaluated: report.adaptersEvaluated })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export { buildRetrievalReport, canonicalBytes, parseArgs, renderMarkdown };
