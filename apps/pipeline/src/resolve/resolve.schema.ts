import { z } from "zod";
import { OntologyRelationshipSchema, type OntologyNode, type OntologyRelationship } from "@devloop/shared";
import type { DroppedRelationshipsReport } from "../infer/llm-relationship-sanitizer";

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

// `Map`은 JSON 직렬화가 안 된다. 파일(Phase 03의 resolve-report.json)에 쓸 때는
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

// Phase 03이 resolve-report.json을 쓸 때 따르는 파일 형태.
// droppedRelationships는 llm-relationship-sanitizer.ts가 이미 JSON 파일로 쓰고 있던
// 형태(DroppedRelationshipsReport)를 그대로 재사용한다 — 별도 스키마로 다시 정의하지 않는다.
export const ResolveReportFileSchema = z.object({
  nodeCount: z.number().int().nonnegative(),
  relationshipCount: z.number().int().nonnegative(),
  unknownConcepts: z.array(UnknownConceptEntrySchema),
  skippedRelationships: SkippedRelationshipsReportSchema,
  rewrittenRelationships: z.number().int().nonnegative(),
});

export type ResolveReportFile = z.infer<typeof ResolveReportFileSchema>;
