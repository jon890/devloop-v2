import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CORE_CONCEPTS, ConceptDictionarySchema, LLM_GRAPH_FILE, type ConceptDictionary } from "@devloop/shared";
import { LlmReasoningEffortSchema, type LlmCli, type LlmReasoningEffort } from "../llm";
import { buildExtractionPrompt, buildJsonRepairPrompt, EXTRACTION_PROMPT_VERSION, type ExtractionPromptDocument } from "./extraction-prompt";
import { LlmExtractionSchema, type LlmExtraction } from "./llm-extraction.schema";
import { sanitizeLlmExtractions, type DroppedRelationshipsReport } from "./llm-relationship-sanitizer";
import { firstString, readRawProject, textContent } from "../raw-reader";

const CacheEntrySchema = LlmExtractionSchema.transform((result) => result);

interface CacheEnvelope {
  docId: string;
  model: string;
  promptVersion: string;
  result: LlmExtraction;
}

export interface LlmExtractionOptions {
  dataRoot: string;
  project: string;
  model: string;
  effort?: LlmReasoningEffort;
  llm: LlmCli;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** 파일럿·부분 재실행용 sourceDocId 허용 목록 (예: "Task:483", "Wiki:123"). 비우면 전체. */
  docFilter?: readonly string[];
}

export interface LlmFailure {
  docId: string;
  error: string;
}

export interface LlmExtractionReport {
  outputPath: string;
  failureReportPath: string;
  droppedRelationshipsReportPath: string;
  documents: number;
  processed: number;
  cacheHits: number;
  failed: LlmFailure[];
  calls: number;
  rewrittenRelationships: number;
  droppedRelationships: DroppedRelationshipsReport;
}

interface DocumentResult {
  document: ExtractionPromptDocument;
  extraction?: LlmExtraction;
  cacheHit: boolean;
  calls: number;
  failure?: LlmFailure;
}

interface ExtractionContext {
  document: ExtractionPromptDocument;
  effort: LlmReasoningEffort | undefined;
  modelIdentity: string;
  cachePath: string;
  cacheIdentity: Omit<CacheEnvelope, "result">;
}

class CompletionError extends Error {
  constructor(
    message: string,
    readonly calls: number,
  ) {
    super(message);
    this.name = "CompletionError";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cacheSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function parseJsonResponse(text: string): LlmExtraction {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("LLM response did not contain a JSON object.");
  return LlmExtractionSchema.parse(JSON.parse(unfenced.slice(start, end + 1)));
}

function validateSourceDocId(extraction: LlmExtraction, sourceDocId: string): LlmExtraction {
  for (const node of extraction.nodes) {
    if (node.properties.sourceDocId !== sourceDocId) {
      throw new Error(`Node ${node.key} has sourceDocId=${node.properties.sourceDocId}; expected ${sourceDocId}.`);
    }
  }
  for (const relationship of extraction.relationships) {
    if (relationship.properties.sourceDocId !== sourceDocId) {
      throw new Error(`Relationship ${relationship.type} has sourceDocId=${String(relationship.properties.sourceDocId)}; expected ${sourceDocId}.`);
    }
  }
  return extraction;
}

async function readProjectConcepts(dataRoot: string, project: string): Promise<ConceptDictionary> {
  const projectPath = path.join(dataRoot, "concepts", `${project}.json`);
  let projectConcepts: ConceptDictionary = [];
  try {
    projectConcepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(projectPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const byCanonical = new Map<string, ConceptDictionary[number]>();
  for (const entry of [...CORE_CONCEPTS, ...projectConcepts]) {
    const existing = byCanonical.get(entry.canonical);
    byCanonical.set(
      entry.canonical,
      existing
        ? {
            canonical: entry.canonical,
            kind: existing.kind,
            aliases: [...new Set([...existing.aliases, ...entry.aliases])],
          }
        : { canonical: entry.canonical, kind: entry.kind, aliases: [...entry.aliases] },
    );
  }
  return ConceptDictionarySchema.parse([...byCanonical.values()]);
}

async function readCache(cachePath: string, expected: Omit<CacheEnvelope, "result">): Promise<LlmExtraction | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as Partial<CacheEnvelope>;
    if (raw.docId !== expected.docId || raw.model !== expected.model || raw.promptVersion !== expected.promptVersion) return undefined;
    return CacheEntrySchema.parse(raw.result);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    return undefined;
  }
}

async function completeWithBackoff(
  llm: LlmCli,
  prompt: string,
  model: string,
  effort: LlmReasoningEffort | undefined,
  timeoutMs: number | undefined,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<{ text: string; calls: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await llm.complete(prompt, { model, effort, timeoutMs });
      return { text: result.text, calls: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new CompletionError(lastError instanceof Error ? lastError.message : String(lastError), maxAttempts);
}

function createExtractionContext(document: ExtractionPromptDocument, options: LlmExtractionOptions): ExtractionContext {
  const effort = options.effort;
  const modelIdentity = `${options.model}@${effort ?? "default"}`;
  const cacheModelSegment = `${cacheSegment(options.model)}@${cacheSegment(effort ?? "default")}`;
  const cachePath = path.join(options.dataRoot, "cache", cacheModelSegment, `${cacheSegment(document.sourceDocId)}.json`);
  return {
    document,
    effort,
    modelIdentity,
    cachePath,
    cacheIdentity: {
      docId: document.sourceDocId,
      model: modelIdentity,
      promptVersion: EXTRACTION_PROMPT_VERSION,
    },
  };
}

async function cachedDocumentResult(context: ExtractionContext): Promise<DocumentResult | undefined> {
  const cached = await readCache(context.cachePath, context.cacheIdentity);
  if (!cached) {
    return undefined;
  }
  try {
    return {
      document: context.document,
      extraction: validateSourceDocId(cached, context.document.sourceDocId),
      cacheHit: true,
      calls: 0,
    };
  } catch {
    // A stale or manually modified cache entry is treated as a miss.
    return undefined;
  }
}

async function completeExtraction(
  prompt: string,
  context: ExtractionContext,
  options: Required<Pick<LlmExtractionOptions, "maxAttempts" | "retryDelayMs">> & LlmExtractionOptions,
): Promise<{ extraction: LlmExtraction; calls: number }> {
  const first = await completeWithBackoff(
    options.llm,
    prompt,
    options.model,
    context.effort,
    options.timeoutMs,
    options.maxAttempts,
    options.retryDelayMs,
  );
  try {
    return {
      extraction: validateSourceDocId(parseJsonResponse(first.text), context.document.sourceDocId),
      calls: first.calls,
    };
  } catch (firstParseError) {
    return repairExtraction(prompt, first.text, first.calls, firstParseError, context, options);
  }
}

async function repairExtraction(
  prompt: string,
  firstText: string,
  firstCalls: number,
  firstParseError: unknown,
  context: ExtractionContext,
  options: Required<Pick<LlmExtractionOptions, "maxAttempts" | "retryDelayMs">> & LlmExtractionOptions,
): Promise<{ extraction: LlmExtraction; calls: number }> {
  let repair;
  try {
    repair = await completeWithBackoff(
      options.llm,
      buildJsonRepairPrompt(prompt, firstText),
      options.model,
      context.effort,
      options.timeoutMs,
      options.maxAttempts,
      options.retryDelayMs,
    );
  } catch (error) {
    if (error instanceof CompletionError) {
      throw new CompletionError(error.message, firstCalls + error.calls);
    }
    throw error;
  }
  try {
    return {
      extraction: validateSourceDocId(parseJsonResponse(repair.text), context.document.sourceDocId),
      calls: firstCalls + repair.calls,
    };
  } catch (repairError) {
    throw new CompletionError(
      `JSON repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}; first error: ${firstParseError instanceof Error ? firstParseError.message : String(firstParseError)}`,
      firstCalls + repair.calls,
    );
  }
}

async function writeCache(context: ExtractionContext, extraction: LlmExtraction): Promise<void> {
  await mkdir(path.dirname(context.cachePath), { recursive: true });
  const envelope: CacheEnvelope = { ...context.cacheIdentity, result: extraction };
  await writeFile(context.cachePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

async function extractOne(
  document: ExtractionPromptDocument,
  concepts: ConceptDictionary,
  options: Required<Pick<LlmExtractionOptions, "maxAttempts" | "retryDelayMs">> & LlmExtractionOptions,
): Promise<DocumentResult> {
  const context = createExtractionContext(document, options);
  const cached = await cachedDocumentResult(context);
  if (cached) return cached;

  const prompt = buildExtractionPrompt(document, concepts);
  let calls = 0;
  try {
    const completed = await completeExtraction(prompt, context, options);
    const extraction = completed.extraction;
    calls += completed.calls;
    await writeCache(context, extraction);
    return { document, extraction, cacheHit: false, calls };
  } catch (error) {
    if (error instanceof CompletionError) calls += error.calls;
    return {
      document,
      cacheHit: false,
      calls,
      failure: {
        docId: document.sourceDocId,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function buildLlmDocuments(dataRoot: string, project: string): Promise<ExtractionPromptDocument[]> {
  const raw = await readRawProject(dataRoot, project);
  const documents: ExtractionPromptDocument[] = [];
  for (const postDocument of raw.posts) {
    const number = firstString(postDocument.post, ["number", "postNumber", "id"]);
    if (!number) throw new Error("Raw post is missing number/postNumber/id.");
    const comments = postDocument.comments.map((comment, index) => {
      const commentId = firstString(comment, ["commentId", "id"]) ?? `${number}-${index + 1}`;
      return `[Comment:${commentId}] ${textContent(comment)}`;
    });
    documents.push({
      sourceDocId: `Task:${number}`,
      label: "Task",
      key: number,
      subject: firstString(postDocument.post, ["subject", "title"]) ?? `Task ${number}`,
      content: [textContent(postDocument.post), ...comments].filter(Boolean).join("\n"),
    });
  }
  for (const wiki of raw.wikis) {
    const pageId = firstString(wiki, ["pageId", "id"]);
    if (!pageId) throw new Error("Raw wiki page is missing pageId/id.");
    documents.push({
      sourceDocId: `Wiki:${pageId}`,
      label: "Wiki",
      key: pageId,
      subject: firstString(wiki, ["subject", "title"]) ?? `Wiki ${pageId}`,
      content: textContent(wiki),
    });
  }
  return documents;
}

export async function extractLlm(options: LlmExtractionOptions): Promise<LlmExtractionReport> {
  const concurrency = options.concurrency ?? 4;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const effort = LlmReasoningEffortSchema.optional().parse(options.effort ?? process.env.LLM_REASONING_EFFORT);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("maxAttempts must be an integer between 1 and 3.");
  }
  const [allDocuments, concepts] = await Promise.all([
    buildLlmDocuments(options.dataRoot, options.project),
    readProjectConcepts(options.dataRoot, options.project),
  ]);
  const docFilter = options.docFilter?.length ? new Set(options.docFilter) : undefined;
  const documents = docFilter ? allDocuments.filter((document) => docFilter.has(document.sourceDocId)) : allDocuments;
  const results = await mapConcurrent(documents, concurrency, (document) =>
    extractOne(document, concepts, {
      ...options,
      effort,
      maxAttempts,
      retryDelayMs,
    }),
  );
  const outputDir = path.join(options.dataRoot, "graph", options.project);
  const outputPath = path.join(outputDir, LLM_GRAPH_FILE);
  const failureReportPath = path.join(outputDir, "llm-failures.json");
  const droppedRelationshipsReportPath = path.join(outputDir, "llm-dropped-relationships.json");
  const sanitized = await sanitizeLlmExtractions(
    options.dataRoot,
    options.project,
    results.flatMap((result) => (result.extraction ? [result.extraction] : [])),
  );
  const records = sanitized.extractions.flatMap((extraction) => [...extraction.nodes, ...extraction.relationships]);
  const failed = results.flatMap((result) => (result.failure ? [result.failure] : []));
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(outputPath, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "", "utf8"),
    writeFile(failureReportPath, `${JSON.stringify(failed, null, 2)}\n`, "utf8"),
    writeFile(droppedRelationshipsReportPath, `${JSON.stringify({ droppedRelationships: sanitized.droppedRelationships }, null, 2)}\n`, "utf8"),
  ]);
  return {
    outputPath,
    failureReportPath,
    droppedRelationshipsReportPath,
    documents: documents.length,
    processed: results.filter((result) => result.extraction).length,
    cacheHits: results.filter((result) => result.cacheHit).length,
    failed,
    calls: results.reduce((sum, result) => sum + result.calls, 0),
    rewrittenRelationships: sanitized.rewrittenRelationships,
    droppedRelationships: sanitized.droppedRelationships,
  };
}
