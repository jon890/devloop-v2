import { z } from "zod";
import { MEMORY_CONFIDENCES, MEMORY_KINDS, MEMORY_SCHEMA_VERSION, MEMORY_SOURCE_TYPES, MEMORY_STATUSES } from "./memory.const";
import { sourceRefKey } from "./memory.serialization";

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GitRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), "HTTP URL이어야 합니다.");
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MemorySourceTypeSchema = z.enum(MEMORY_SOURCE_TYPES);
export type MemorySourceType = z.infer<typeof MemorySourceTypeSchema>;

export const SourceRefSchema = z
  .object({
    sourceType: MemorySourceTypeSchema,
    sourceId: z.string().min(1),
    url: HttpUrlSchema,
    title: z.string().min(1),
    repository: z.string().min(1).optional(),
    revision: GitRevisionSchema.optional(),
    path: z.string().min(1).optional(),
    parentId: z.string().min(1).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((ref, context) => {
    if (ref.sourceType.startsWith("git-")) {
      if (!ref.repository) context.addIssue({ code: z.ZodIssueCode.custom, path: ["repository"], message: "Git 원천에는 repository가 필요합니다." });
      if (!ref.revision) context.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "Git 원천에는 revision이 필요합니다." });
    }
    if (ref.sourceType === "git-file" && !ref.path) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "git-file에는 path가 필요합니다." });
    }
    if (ref.sourceType === "git-commit" && ref.repository && ref.revision && ref.sourceId !== `${ref.repository}@${ref.revision}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "git-commit sourceId 계약과 다릅니다." });
    }
    if (
      ref.sourceType === "git-file" &&
      ref.repository &&
      ref.revision &&
      ref.path &&
      ref.sourceId !== `${ref.repository}@${ref.revision}:${ref.path}`
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceId"], message: "git-file sourceId 계약과 다릅니다." });
    }
    if (ref.sourceType === "dooray-comment" && !ref.parentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentId"], message: "Dooray comment에는 parentId가 필요합니다." });
    }
  });
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const EvidenceScopeSchema = z.object({
  project: z.string().min(1),
  repositories: z.array(z.string().min(1)),
  paths: z.array(z.string().min(1)),
});
export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;

export const EvidenceSegmentSchema = z.object({
  sourceRefKey: z.string().min(1),
  text: z.string().min(1),
});
export type EvidenceSegment = z.infer<typeof EvidenceSegmentSchema>;

export const EvidencePacketSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    id: z.string().min(1),
    project: z.string().min(1),
    sourceKind: MemorySourceTypeSchema,
    title: z.string().min(1),
    scope: EvidenceScopeSchema,
    segments: z.array(EvidenceSegmentSchema).min(1),
    sourceRefs: z.array(SourceRefSchema).min(1),
    contentHash: Sha256Schema,
  })
  .superRefine((packet, context) => {
    const keys = new Set<string>();
    for (const [index, ref] of packet.sourceRefs.entries()) {
      const key = sourceRefKey(ref);
      if (keys.has(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRefs", index], message: `중복 SourceRef입니다: ${key}` });
      }
      keys.add(key);
    }
    const usedKeys = new Set<string>();
    for (const [index, segment] of packet.segments.entries()) {
      if (!keys.has(segment.sourceRefKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index, "sourceRefKey"],
          message: `존재하지 않는 SourceRef를 가리킵니다: ${segment.sourceRefKey}`,
        });
      }
      usedKeys.add(segment.sourceRefKey);
    }
    for (const [index, ref] of packet.sourceRefs.entries()) {
      const key = sourceRefKey(ref);
      if (!usedKeys.has(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRefs", index], message: `segment가 사용하지 않는 SourceRef입니다: ${key}` });
      }
    }
  });
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;

export const MemoryKindSchema = z.enum(MEMORY_KINDS);
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);
export const MemoryConfidenceSchema = z.enum(MEMORY_CONFIDENCES);

export const MemoryScopeSchema = EvidenceScopeSchema.extend({
  modules: z.array(z.string().min(1)),
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryRecordSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  id: z.string().regex(/^mem-[0-9a-f]{64}$/),
  title: z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), "title은 한 줄이어야 합니다."),
  kind: MemoryKindSchema,
  status: MemoryStatusSchema,
  confidence: MemoryConfidenceSchema,
  summary: z.string().min(1),
  why: z.string().min(1),
  doNot: z.array(z.string().min(1)),
  scope: MemoryScopeSchema,
  validFrom: DateSchema,
  validUntil: DateSchema.nullable(),
  lastVerified: DateSchema,
  relatedTerms: z.array(z.string().min(1)),
  sourceRefs: z.array(SourceRefSchema).min(1),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
