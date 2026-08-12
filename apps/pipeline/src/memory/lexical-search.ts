import type { MemoryRecord, SourceRef } from "@devloop/shared";
import { normalizeProjectCode } from "../cli-options";
import { compareText } from "./evidence-serialization";
import { readCurrentWikiIndexWithHash, type WikiIndex, type WikiIndexEntry } from "./wiki-builder";

const MAX_TOP_K = 50;
const DEFAULT_TOP_K = 10;

const FIELD_WEIGHTS = {
  title: 8,
  relatedTerms: 7,
  summary: 3,
  why: 2,
  scope: 1,
} as const;

const CONFIDENCE_RANK: Record<MemoryRecord["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const STATUS_RANK: Record<MemoryRecord["status"], number> = {
  active: 5,
  uncertain: 4,
  historical: 3,
  deprecated: 2,
  superseded: 1,
};

const STATUS_PENALTY: Record<MemoryRecord["status"], number> = {
  active: 0,
  uncertain: 1,
  historical: 2,
  deprecated: 3,
  superseded: 4,
};

export interface SearchScopeFilter {
  project?: string;
  repository?: string;
  module?: string;
  path?: string;
}

export interface SearchOptions extends SearchScopeFilter {
  query: string;
  topK?: number;
  allowIncomplete?: boolean;
}

export interface MemorySearchResult {
  id: string;
  title: string;
  kind: MemoryRecord["kind"];
  status: MemoryRecord["status"];
  confidence: MemoryRecord["confidence"];
  summary: string;
  score: number;
  matchedTerms: string[];
  sourceRefs: SourceRef[];
  statusWarning?: string;
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
  searchMs: number;
  documentsScanned: number;
  returned: number;
  memoryIndexHash?: string;
}

export function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLowerCase()
        .split(/[\s\p{P}\p{S}]+/u)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
}

function fieldMatches(field: string | readonly string[], terms: readonly string[]): Set<string> {
  const haystacks = (Array.isArray(field) ? field : [field]).map((value) => value.normalize("NFKC").toLowerCase());
  return new Set(terms.filter((term) => haystacks.some((haystack) => haystack.includes(term))));
}

function scoreDocument(document: WikiIndexEntry, terms: readonly string[]): { score: number; matchedTerms: string[] } {
  const matched = new Set<string>();
  let rawScore = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as Array<[keyof typeof FIELD_WEIGHTS, number]>) {
    const matches = fieldMatches(document.normalized[field], terms);
    for (const term of matches) matched.add(term);
    rawScore += matches.size * weight;
  }
  const score = rawScore > 0 ? Math.max(1, rawScore - STATUS_PENALTY[document.record.status]) : 0;
  return { score, matchedTerms: [...matched].sort(compareText) };
}

function includesExact(values: readonly string[], expected: string): boolean {
  return values.some((value) => value === expected);
}

function includesPath(values: readonly string[], expected: string): boolean {
  return values.some((value) => value === expected || value.startsWith(`${expected}/`) || expected.startsWith(`${value}/`));
}

function matchesScope(document: WikiIndexEntry, filter: SearchScopeFilter): boolean {
  if (filter.project && document.scope.project !== filter.project) return false;
  if (filter.repository && !includesExact(document.scope.repositories, filter.repository)) return false;
  if (filter.module && !includesExact(document.scope.modules, filter.module)) return false;
  if (filter.path && !includesPath(document.scope.paths, filter.path)) return false;
  return true;
}

function limitTopK(topK: number | undefined): number {
  if (topK === undefined) return DEFAULT_TOP_K;
  if (!Number.isInteger(topK) || topK < 1) throw new Error("--top-k는 1 이상의 정수여야 합니다.");
  return Math.min(topK, MAX_TOP_K);
}

export function searchWikiIndex(index: WikiIndex, options: SearchOptions, metadata: { memoryIndexHash?: string } = {}): MemorySearchResponse {
  const startedAt = performance.now();
  if (!index.complete && !options.allowIncomplete) throw new Error("incomplete index는 --allow-incomplete 없이는 검색할 수 없습니다.");
  const terms = tokenize(options.query);
  const topK = limitTopK(options.topK);
  const filtered = index.documents.filter((document) => matchesScope(document, options));
  const scored = terms.length ? filtered.map((document) => ({ document, ...scoreDocument(document, terms) })).filter((entry) => entry.score > 0) : [];
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      CONFIDENCE_RANK[right.document.record.confidence] - CONFIDENCE_RANK[left.document.record.confidence] ||
      STATUS_RANK[right.document.record.status] - STATUS_RANK[left.document.record.status] ||
      compareText(left.document.id, right.document.id),
  );
  const results = scored.slice(0, topK).map(({ document, score, matchedTerms }) => {
    const statusWarning = document.status === "active" ? undefined : `${document.status} 상태의 Memory입니다. 현재 유효성을 확인하세요.`;
    return {
      id: document.id,
      title: document.title,
      kind: document.record.kind,
      status: document.record.status,
      confidence: document.record.confidence,
      summary: document.summary,
      score,
      matchedTerms,
      sourceRefs: document.record.sourceRefs,
      ...(statusWarning ? { statusWarning } : {}),
    };
  });
  return {
    ...(metadata.memoryIndexHash ? { memoryIndexHash: metadata.memoryIndexHash } : {}),
    results,
    searchMs: Math.max(0, Math.round(performance.now() - startedAt)),
    documentsScanned: filtered.length,
    returned: results.length,
  };
}

export async function searchMemory(dataDir: string, project: string, options: Omit<SearchOptions, "project">): Promise<MemorySearchResponse> {
  const projectCode = normalizeProjectCode(project);
  const { index, memoryIndexHash } = await readCurrentWikiIndexWithHash(dataDir, projectCode);
  return searchWikiIndex(index, { ...options, project: projectCode }, { memoryIndexHash });
}
