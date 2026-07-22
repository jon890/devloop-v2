import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OntologyRelationship, RawDoorayObject } from '@devloop/shared';
import {
  LlmNodeSchema,
  LlmRelationshipSchema,
  type LlmExtraction,
} from './llm-extraction.schema';
import { firstString, readRawProject } from './raw-reader';

interface EndpointIndex {
  taskNumbers: Set<string>;
  taskIdToNumber: Map<string, string>;
  wikiPageIds: Set<string>;
  wikiIdToPageId: Map<string, string>;
}

export interface DroppedRelationship {
  relationship: OntologyRelationship;
  reason: string;
}

export interface DroppedRelationshipDocumentReport {
  sourceDocId: string;
  count: number;
  relationships: DroppedRelationship[];
}

export interface DroppedRelationshipsReport {
  count: number;
  documents: DroppedRelationshipDocumentReport[];
}

export interface SanitizeLlmGraphFileResult {
  outputPath: string;
  reportPath: string;
  rewrittenRelationships: number;
  droppedRelationships: DroppedRelationshipsReport;
}

type LlmGraphRecord = LlmExtraction['nodes'][number] | LlmExtraction['relationships'][number];

async function readPostSummaries(dataRoot: string, project: string): Promise<RawDoorayObject[]> {
  const summaryPath = path.join(dataRoot, 'raw', project, 'posts.json');
  try {
    const value = JSON.parse(await readFile(summaryPath, 'utf8')) as unknown;
    if (!Array.isArray(value)) throw new Error(`${summaryPath} must contain a JSON array.`);
    return value.filter(
      (entry): entry is RawDoorayObject => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function buildEndpointIndex(dataRoot: string, project: string): Promise<EndpointIndex> {
  const [raw, postSummaries] = await Promise.all([
    readRawProject(dataRoot, project),
    readPostSummaries(dataRoot, project),
  ]);
  const taskNumbers = new Set<string>();
  const taskIdToNumber = new Map<string, string>();

  for (const post of [...postSummaries, ...raw.posts.map((document) => document.post)]) {
    const number = firstString(post, ['number', 'postNumber']);
    if (!number) continue;
    taskNumbers.add(number);
    const id = firstString(post, ['id']);
    if (id) taskIdToNumber.set(id, number);
  }

  const wikiPageIds = new Set<string>();
  const wikiIdToPageId = new Map<string, string>();
  for (const wiki of raw.wikis) {
    const pageId = firstString(wiki, ['pageId', 'id']);
    if (!pageId) continue;
    wikiPageIds.add(pageId);
    for (const alias of [firstString(wiki, ['pageId']), firstString(wiki, ['id'])]) {
      if (alias) wikiIdToPageId.set(alias, pageId);
    }
  }

  return { taskNumbers, taskIdToNumber, wikiPageIds, wikiIdToPageId };
}

function normalizeEndpoint(endpoint: string, index: EndpointIndex): { key?: string; rewritten: boolean; error?: string } {
  if (endpoint.startsWith('Task:')) {
    const key = endpoint.slice('Task:'.length);
    if (index.taskNumbers.has(key)) return { key: endpoint, rewritten: false };
    const number = index.taskIdToNumber.get(key);
    if (number) return { key: `Task:${number}`, rewritten: true };
    return { rewritten: false, error: `Task endpoint ${endpoint} is absent from the raw task number and post id indexes.` };
  }

  if (endpoint.startsWith('Wiki:')) {
    const key = endpoint.slice('Wiki:'.length);
    if (index.wikiPageIds.has(key)) return { key: endpoint, rewritten: false };
    const pageId = index.wikiIdToPageId.get(key);
    if (pageId) return { key: `Wiki:${pageId}`, rewritten: true };
    return { rewritten: false, error: `Wiki endpoint ${endpoint} is absent from the raw wiki page id index.` };
  }

  return { key: endpoint, rewritten: false };
}

function reportDroppedRelationships(dropped: readonly DroppedRelationship[]): DroppedRelationshipsReport {
  const byDocument = new Map<string, DroppedRelationship[]>();
  for (const item of dropped) {
    const sourceDocId = String(item.relationship.properties.sourceDocId);
    const entries = byDocument.get(sourceDocId) ?? [];
    entries.push(item);
    byDocument.set(sourceDocId, entries);
  }
  return {
    count: dropped.length,
    documents: [...byDocument.entries()].map(([sourceDocId, relationships]) => ({
      sourceDocId,
      count: relationships.length,
      relationships,
    })),
  };
}

async function readDroppedRelationships(reportPath: string): Promise<DroppedRelationship[]> {
  try {
    const value = JSON.parse(await readFile(reportPath, 'utf8')) as {
      droppedRelationships?: { documents?: Array<{ relationships?: unknown[] }> };
    };
    const dropped: DroppedRelationship[] = [];
    for (const document of value.droppedRelationships?.documents ?? []) {
      for (const entry of document.relationships ?? []) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const candidate = entry as { relationship?: unknown; reason?: unknown };
        const relationship = LlmRelationshipSchema.safeParse(candidate.relationship);
        if (relationship.success && typeof candidate.reason === 'string') {
          dropped.push({ relationship: relationship.data, reason: candidate.reason });
        }
      }
    }
    return dropped;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

function mergeDroppedRelationships(
  previous: readonly DroppedRelationship[],
  current: readonly DroppedRelationship[],
): DroppedRelationship[] {
  const merged = new Map<string, DroppedRelationship>();
  for (const entry of [...previous, ...current]) {
    merged.set(JSON.stringify(entry), entry);
  }
  return [...merged.values()];
}

function sanitizeRelationships(
  relationships: readonly LlmExtraction['relationships'][number][],
  index: EndpointIndex,
): {
  relationships: LlmExtraction['relationships'];
  rewrittenRelationships: number;
  dropped: DroppedRelationship[];
} {
  const sanitized: LlmExtraction['relationships'] = [];
  const dropped: DroppedRelationship[] = [];
  let rewrittenRelationships = 0;

  for (const relationship of relationships) {
    const start = normalizeEndpoint(relationship.startKey, index);
    const end = normalizeEndpoint(relationship.endKey, index);
    const reason = start.error ?? end.error;
    if (reason) {
      dropped.push({ relationship, reason });
      continue;
    }
    if (start.rewritten || end.rewritten) rewrittenRelationships += 1;
    sanitized.push({
      ...relationship,
      startKey: start.key ?? relationship.startKey,
      endKey: end.key ?? relationship.endKey,
    });
  }

  return { relationships: sanitized, rewrittenRelationships, dropped };
}

export async function sanitizeLlmExtractions(
  dataRoot: string,
  project: string,
  extractions: readonly LlmExtraction[],
): Promise<{
  extractions: LlmExtraction[];
  rewrittenRelationships: number;
  droppedRelationships: DroppedRelationshipsReport;
}> {
  const index = await buildEndpointIndex(dataRoot, project);
  const dropped: DroppedRelationship[] = [];
  let rewrittenRelationships = 0;
  const sanitized = extractions.map((extraction) => {
    const relationships = sanitizeRelationships(extraction.relationships, index);
    dropped.push(...relationships.dropped);
    rewrittenRelationships += relationships.rewrittenRelationships;
    return { ...extraction, relationships: relationships.relationships };
  });
  return {
    extractions: sanitized,
    rewrittenRelationships,
    droppedRelationships: reportDroppedRelationships(dropped),
  };
}

function parseLlmGraphRecord(value: unknown): LlmGraphRecord {
  const node = LlmNodeSchema.safeParse(value);
  if (node.success) return node.data;
  return LlmRelationshipSchema.parse(value);
}

export async function sanitizeLlmGraphFile(
  dataRoot: string,
  project: string,
): Promise<SanitizeLlmGraphFileResult> {
  const outputPath = path.join(dataRoot, 'graph', project, 'llm.jsonl');
  const reportPath = path.join(dataRoot, 'graph', project, 'llm-dropped-relationships.json');
  let content: string;
  let previousDropped: DroppedRelationship[];
  try {
    [content, previousDropped] = await Promise.all([
      readFile(outputPath, 'utf8'),
      readDroppedRelationships(reportPath),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    content = '';
    previousDropped = await readDroppedRelationships(reportPath);
  }
  const records = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseLlmGraphRecord(JSON.parse(line)));
  const index = await buildEndpointIndex(dataRoot, project);
  const dropped: DroppedRelationship[] = [];
  let rewrittenRelationships = 0;
  const outputRecords: LlmGraphRecord[] = [];
  for (const record of records) {
    if (!('type' in record)) {
      outputRecords.push(record);
      continue;
    }
    const result = sanitizeRelationships([record], index);
    dropped.push(...result.dropped);
    rewrittenRelationships += result.rewrittenRelationships;
    outputRecords.push(...result.relationships);
  }
  const droppedRelationships = reportDroppedRelationships(
    mergeDroppedRelationships(previousDropped, dropped),
  );
  await Promise.all([
    writeFile(
      outputPath,
      outputRecords.length ? `${outputRecords.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
      'utf8',
    ),
    writeFile(reportPath, `${JSON.stringify({ droppedRelationships }, null, 2)}\n`, 'utf8'),
  ]);
  return {
    outputPath,
    reportPath,
    rewrittenRelationships,
    droppedRelationships,
  };
}
