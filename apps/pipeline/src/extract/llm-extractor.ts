import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CORE_CONCEPTS,
  ConceptDictionarySchema,
  type ConceptDictionary,
} from '@devloop/shared';
import type { LlmCli } from '../llm';
import {
  buildExtractionPrompt,
  buildJsonRepairPrompt,
  EXTRACTION_PROMPT_VERSION,
  type ExtractionPromptDocument,
} from './extraction-prompt';
import { LlmExtractionSchema, type LlmExtraction } from './llm-extraction.schema';
import { firstString, readRawProject, textContent } from './raw-reader';

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
  documents: number;
  processed: number;
  cacheHits: number;
  failed: LlmFailure[];
  calls: number;
}

interface DocumentResult {
  document: ExtractionPromptDocument;
  extraction?: LlmExtraction;
  cacheHit: boolean;
  calls: number;
  failure?: LlmFailure;
}

class CompletionError extends Error {
  constructor(message: string, readonly calls: number) {
    super(message);
    this.name = 'CompletionError';
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cacheSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}

function parseJsonResponse(text: string): LlmExtraction {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM response did not contain a JSON object.');
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
      throw new Error(
        `Relationship ${relationship.type} has sourceDocId=${String(relationship.properties.sourceDocId)}; expected ${sourceDocId}.`,
      );
    }
  }
  return extraction;
}

async function readProjectConcepts(dataRoot: string, project: string): Promise<ConceptDictionary> {
  const projectPath = path.join(dataRoot, 'concepts', `${project}.json`);
  let projectConcepts: ConceptDictionary = [];
  try {
    projectConcepts = ConceptDictionarySchema.parse(JSON.parse(await readFile(projectPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const byCanonical = new Map<string, ConceptDictionary[number]>();
  for (const entry of [...CORE_CONCEPTS, ...projectConcepts]) {
    const existing = byCanonical.get(entry.canonical);
    byCanonical.set(entry.canonical, existing ? {
      canonical: entry.canonical,
      kind: existing.kind,
      aliases: [...new Set([...existing.aliases, ...entry.aliases])],
    } : { canonical: entry.canonical, kind: entry.kind, aliases: [...entry.aliases] });
  }
  return ConceptDictionarySchema.parse([...byCanonical.values()]);
}

async function readCache(cachePath: string, expected: Omit<CacheEnvelope, 'result'>): Promise<LlmExtraction | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<CacheEnvelope>;
    if (
      raw.docId !== expected.docId ||
      raw.model !== expected.model ||
      raw.promptVersion !== expected.promptVersion
    ) return undefined;
    return CacheEntrySchema.parse(raw.result);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    return undefined;
  }
}

async function completeWithBackoff(
  llm: LlmCli,
  prompt: string,
  model: string,
  timeoutMs: number | undefined,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<{ text: string; calls: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await llm.complete(prompt, { model, timeoutMs });
      return { text: result.text, calls: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new CompletionError(
    lastError instanceof Error ? lastError.message : String(lastError),
    maxAttempts,
  );
}

async function extractOne(
  document: ExtractionPromptDocument,
  concepts: ConceptDictionary,
  options: Required<Pick<LlmExtractionOptions, 'maxAttempts' | 'retryDelayMs'>> & LlmExtractionOptions,
): Promise<DocumentResult> {
  const cachePath = path.join(
    options.dataRoot,
    'cache',
    cacheSegment(options.model),
    `${cacheSegment(document.sourceDocId)}.json`,
  );
  const cacheIdentity = {
    docId: document.sourceDocId,
    model: options.model,
    promptVersion: EXTRACTION_PROMPT_VERSION,
  };
  const cached = await readCache(cachePath, cacheIdentity);
  if (cached) {
    try {
      return {
        document,
        extraction: validateSourceDocId(cached, document.sourceDocId),
        cacheHit: true,
        calls: 0,
      };
    } catch {
      // A stale or manually modified cache entry is treated as a miss.
    }
  }

  const prompt = buildExtractionPrompt(document, concepts);
  let calls = 0;
  try {
    const first = await completeWithBackoff(
      options.llm,
      prompt,
      options.model,
      options.timeoutMs,
      options.maxAttempts,
      options.retryDelayMs,
    );
    calls += first.calls;
    let extraction: LlmExtraction;
    try {
      extraction = validateSourceDocId(parseJsonResponse(first.text), document.sourceDocId);
    } catch (firstParseError) {
      const repair = await completeWithBackoff(
        options.llm,
        buildJsonRepairPrompt(prompt, first.text),
        options.model,
        options.timeoutMs,
        options.maxAttempts,
        options.retryDelayMs,
      );
      calls += repair.calls;
      try {
        extraction = validateSourceDocId(parseJsonResponse(repair.text), document.sourceDocId);
      } catch (repairError) {
        throw new Error(
          `JSON repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}; first error: ${firstParseError instanceof Error ? firstParseError.message : String(firstParseError)}`,
        );
      }
    }
    await mkdir(path.dirname(cachePath), { recursive: true });
    const envelope: CacheEnvelope = { ...cacheIdentity, result: extraction };
    await writeFile(cachePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
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

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
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
    const number = firstString(postDocument.post, ['number', 'postNumber', 'id']);
    if (!number) throw new Error('Raw post is missing number/postNumber/id.');
    const comments = postDocument.comments.map((comment, index) => {
      const commentId = firstString(comment, ['commentId', 'id']) ?? `${number}-${index + 1}`;
      return `[Comment:${commentId}] ${textContent(comment)}`;
    });
    documents.push({
      sourceDocId: `Task:${number}`,
      label: 'Task',
      key: number,
      subject: firstString(postDocument.post, ['subject', 'title']) ?? `Task ${number}`,
      content: [textContent(postDocument.post), ...comments].filter(Boolean).join('\n'),
    });
  }
  for (const wiki of raw.wikis) {
    const pageId = firstString(wiki, ['pageId', 'id']);
    if (!pageId) throw new Error('Raw wiki page is missing pageId/id.');
    documents.push({
      sourceDocId: `Wiki:${pageId}`,
      label: 'Wiki',
      key: pageId,
      subject: firstString(wiki, ['subject', 'title']) ?? `Wiki ${pageId}`,
      content: textContent(wiki),
    });
  }
  return documents;
}

export async function extractLlm(options: LlmExtractionOptions): Promise<LlmExtractionReport> {
  const concurrency = options.concurrency ?? 4;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error('maxAttempts must be an integer between 1 and 3.');
  }
  const [allDocuments, concepts] = await Promise.all([
    buildLlmDocuments(options.dataRoot, options.project),
    readProjectConcepts(options.dataRoot, options.project),
  ]);
  const docFilter = options.docFilter?.length ? new Set(options.docFilter) : undefined;
  const documents = docFilter
    ? allDocuments.filter((document) => docFilter.has(document.sourceDocId))
    : allDocuments;
  const results = await mapConcurrent(documents, concurrency, (document) => extractOne(document, concepts, {
    ...options,
    maxAttempts,
    retryDelayMs,
  }));
  const outputDir = path.join(options.dataRoot, 'graph', options.project);
  const outputPath = path.join(outputDir, 'llm.jsonl');
  const failureReportPath = path.join(outputDir, 'llm-failures.json');
  const records = results.flatMap((result) => result.extraction
    ? [...result.extraction.nodes, ...result.extraction.relationships]
    : []);
  const failed = results.flatMap((result) => result.failure ? [result.failure] : []);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(outputPath, records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '', 'utf8'),
    writeFile(failureReportPath, `${JSON.stringify(failed, null, 2)}\n`, 'utf8'),
  ]);
  return {
    outputPath,
    failureReportPath,
    documents: documents.length,
    processed: results.filter((result) => result.extraction).length,
    cacheHits: results.filter((result) => result.cacheHit).length,
    failed,
    calls: results.reduce((sum, result) => sum + result.calls, 0),
  };
}
