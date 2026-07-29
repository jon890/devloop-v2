import { z } from "zod";
import { OntologyRelationshipSchema, type OntologyNode, type OntologyRelationship } from "@devloop/shared";
import type { DroppedRelationshipsReport } from "../infer/llm-relationship-sanitizer";

export const DroppedRelationshipSchema = z.object({
  relationship: OntologyRelationshipSchema,
  reason: z.string(),
});

export const DroppedRelationshipDocumentReportSchema = z.object({
  sourceDocId: z.string(),
  count: z.number().int().nonnegative(),
  relationships: z.array(DroppedRelationshipSchema),
});

export const DroppedRelationshipsReportSchema = z.object({
  count: z.number().int().nonnegative(),
  documents: z.array(DroppedRelationshipDocumentReportSchema),
});

export interface SkippedRelationshipSample {
  sourceFile: string;
  relationship: OntologyRelationship;
  error: string;
}

export interface SkippedRelationshipsReport {
  count: number;
  samples: SkippedRelationshipSample[];
}

export interface SourcedRecord {
  value: unknown;
  sourceFile: string;
}

export interface ResolveResult {
  nodes: OntologyNode[];
  relationships: OntologyRelationship[];
  unknownConcepts: Map<string, number>;
  skippedRelationships: SkippedRelationshipsReport;
  droppedRelationships: DroppedRelationshipsReport;
  rewrittenRelationships: number;
}

// `Map`은 JSON 직렬화가 안 된다. 파일(resolve-report.json)에 쓸 때는
// 정렬된 [key, count] 튜플 배열로 표현한다 — 문자열 키를 객체 속성으로 쓰면
// 숫자처럼 보이는 키(예: "483")가 JS 엔진의 정수 키 정렬 규칙에 걸려
// 우리가 지정한 정렬 순서가 뒤바뀔 수 있기 때문이다. 튜플 배열은 그 위험이 없다.
export const UnknownConceptEntrySchema = z.tuple([z.string(), z.number().int().nonnegative()]);

export const SkippedRelationshipSampleSchema = z.object({
  sourceFile: z.string(),
  relationship: OntologyRelationshipSchema,
  error: z.string(),
});

export const SkippedRelationshipsReportSchema = z.object({
  count: z.number().int().nonnegative(),
  samples: z.array(SkippedRelationshipSampleSchema),
});

// `resolve-graph` 가 `resolve-report.json` 을 쓸 때 따르는 파일 형태.
// `docs/data-schema.md` 가 이 리포트에 "미매칭 Concept·건너뛴 관계·버린 관계·재작성 수" 네 가지를
// 담는다고 계약했다 — droppedRelationships 가 빠지면 콘솔 로그에만 남고 파일에는 안 남아
// dry-run 비교(이 단계의 존재 이유) 대상에서 빠진다.
export const ResolveReportFileSchema = z.object({
  nodeCount: z.number().int().nonnegative(),
  relationshipCount: z.number().int().nonnegative(),
  unknownConcepts: z.array(UnknownConceptEntrySchema),
  skippedRelationships: SkippedRelationshipsReportSchema,
  droppedRelationships: DroppedRelationshipsReportSchema,
  rewrittenRelationships: z.number().int().nonnegative(),
});

export type ResolveReportFile = z.infer<typeof ResolveReportFileSchema>;
