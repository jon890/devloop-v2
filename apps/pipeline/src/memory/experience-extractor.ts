import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_SOURCE_POINTER_FILE,
  EVIDENCE_FILE,
  MEMORY_SCHEMA_VERSION,
  MemoryRecordSchema,
  SOURCE_GENERATIONS_DIRECTORY,
  SOURCE_MANIFEST_FILE,
  sourceRefKey,
  type EvidencePacket,
  type MemoryRecord,
} from "@devloop/shared";
import { ResponsesCliAdapter, type LlmCli } from "../llm";
import { compareText, hashCanonical, sha256 } from "./evidence-serialization";
import { readExtractionCache, writeExtractionCache, type ExtractionCacheIdentity } from "./experience-cache";
import { ExperienceExtractionOutputSchema, type ExperienceDraft, type ExperienceExtractionOutput } from "./experience-extraction.schema";
import { buildExperiencePrompt, EXPERIENCE_OUTPUT_JSON_SCHEMA, EXPERIENCE_PROMPT_VERSION } from "./experience-prompt";
import {
  ExtractionSelectionSchema,
  publishExtractionGeneration,
  publishExtractionRun,
  type ExtractionSelection,
} from "./extraction-generation-publisher";
import { SourceManifestSchema, SourcePointerSchema, validateEvidenceJsonl } from "./source-generation-publisher";

export const MEMORY_EXTRACTION_MODEL = "gpt-5.6-luna" as const;
export const MEMORY_EXTRACTION_EFFORT = "low" as const;

export interface ExtractExperienceOptions {
  project: string;
  dataDir: string;
  limit?: number;
  ids?: readonly string[];
  samplePerSource?: number;
}

export interface ExtractExperienceResult {
  project: string;
  sourceGenerationId: string;
  extractionGenerationId: string;
  generationDirectory: string;
  runId: string;
  runDirectory: string;
  complete: boolean;
  selectedPackets: number;
  succeededPackets: number;
  failedPackets: number;
  memories: number;
  calls: number;
  cacheHits: number;
}

interface CurrentSourceGeneration {
  sourceGenerationId: string;
  sourceManifestHash: string;
  packets: EvidencePacket[];
}

function normalizeTitleForId(title: string): string {
  return title.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCurrentSource(dataDir: string, project: string): Promise<CurrentSourceGeneration> {
  const projectDirectory = path.join(dataDir, "memory", project);
  const pointer = SourcePointerSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, CURRENT_SOURCE_POINTER_FILE), "utf8")) as unknown);
  const generationDirectory = path.join(projectDirectory, SOURCE_GENERATIONS_DIRECTORY, pointer.generationId);
  const [manifestText, evidenceText] = await Promise.all([
    readFile(path.join(generationDirectory, SOURCE_MANIFEST_FILE), "utf8"),
    readFile(path.join(generationDirectory, EVIDENCE_FILE), "utf8"),
  ]);
  const manifest = SourceManifestSchema.parse(JSON.parse(manifestText) as unknown);
  if (manifest.project !== project || manifest.sourceGenerationId !== pointer.generationId) {
    throw new Error(`current source pointer와 source manifest가 일치하지 않습니다: ${project}`);
  }
  return {
    sourceGenerationId: manifest.sourceGenerationId,
    sourceManifestHash: sha256(manifestText),
    packets: validateEvidenceJsonl(evidenceText).sort((left, right) => compareText(left.id, right.id)),
  };
}

function selectPackets(
  packets: readonly EvidencePacket[],
  options: ExtractExperienceOptions,
): {
  selection: ExtractionSelection;
  packets: EvidencePacket[];
} {
  const selectors = [options.limit !== undefined, options.ids !== undefined, options.samplePerSource !== undefined].filter(Boolean).length;
  if (selectors > 1) throw new Error("--limit, --ids, --sample-per-source는 상호 배타입니다.");

  if (options.limit !== undefined) {
    const selection = ExtractionSelectionSchema.parse({ mode: "limit", limit: options.limit });
    if (selection.mode !== "limit") throw new Error("limit selection 검증에 실패했습니다.");
    return { selection, packets: packets.slice(0, selection.limit) };
  }
  if (options.ids !== undefined) {
    const ids = [...new Set(options.ids.map((id) => id.trim()).filter(Boolean))].sort(compareText);
    const selection = ExtractionSelectionSchema.parse({ mode: "ids", ids });
    const byId = new Map(packets.map((packet) => [packet.id, packet]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) throw new Error(`존재하지 않는 evidence packet ID: ${unknown.join(", ")}`);
    return { selection, packets: ids.map((id) => byId.get(id) as EvidencePacket) };
  }
  if (options.samplePerSource !== undefined) {
    const selection = ExtractionSelectionSchema.parse({ mode: "sample-per-source", samplePerSource: options.samplePerSource });
    if (selection.mode !== "sample-per-source") throw new Error("sample-per-source selection 검증에 실패했습니다.");
    const groups = new Map<string, EvidencePacket[]>();
    for (const packet of packets) {
      const group = groups.get(packet.sourceKind) ?? [];
      group.push(packet);
      groups.set(packet.sourceKind, group);
    }
    const selected = [...groups.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .flatMap(([, group]) => group.sort((left, right) => compareText(left.id, right.id)).slice(0, selection.samplePerSource))
      .sort((left, right) => compareText(left.id, right.id));
    return { selection, packets: selected };
  }
  return { selection: { mode: "all" }, packets: [...packets] };
}

function resolveDrafts(packet: EvidencePacket, outputInput: ExperienceExtractionOutput): MemoryRecord[] {
  const output = ExperienceExtractionOutputSchema.parse(outputInput);
  const refs = new Map(packet.sourceRefs.map((ref) => [sourceRefKey(ref), ref]));
  for (const draft of output.memories) {
    const unknown = draft.sourceRefKeys.filter((key) => !refs.has(key));
    if (unknown.length > 0) {
      throw new Error(`packet ${packet.id}의 Memory가 존재하지 않는 sourceRefKeys를 선택했습니다: ${unknown.join(", ")}`);
    }
  }

  const records = output.memories.map((draft) => memoryRecord(packet, draft, refs));
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`packet ${packet.id}에 중복 Memory ID가 있습니다: ${record.id}`);
    ids.add(record.id);
  }
  return records.sort((left, right) => compareText(left.id, right.id));
}

function memoryRecord(packet: EvidencePacket, draft: ExperienceDraft, refs: ReadonlyMap<string, EvidencePacket["sourceRefs"][number]>): MemoryRecord {
  const sortedKeys = [...new Set(draft.sourceRefKeys)].sort(compareText);
  const id = `mem-${hashCanonical({
    kind: draft.kind,
    title: normalizeTitleForId(draft.title),
    sourceRefKeys: sortedKeys,
  }).slice("sha256:".length)}`;
  return MemoryRecordSchema.parse({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id,
    title: draft.title.trim().replace(/\s+/g, " "),
    kind: draft.kind,
    status: draft.status,
    confidence: draft.confidence,
    summary: draft.summary,
    why: draft.why,
    doNot: draft.doNot,
    scope: draft.scope,
    validFrom: draft.validFrom,
    validUntil: draft.validUntil,
    lastVerified: draft.lastVerified,
    relatedTerms: draft.relatedTerms,
    sourceRefs: sortedKeys.map((key) => refs.get(key)),
  });
}

function parseLlmOutput(packetId: string, text: string): ExperienceExtractionOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`packet ${packetId}의 structured output이 JSON이 아닙니다: ${errorMessage(error)}`);
  }
  return ExperienceExtractionOutputSchema.parse(parsed);
}

/** 제품 진입점은 provider 주입 표면 없이 Responses 직접 전송만 생성한다. */
export async function extractExperience(options: ExtractExperienceOptions): Promise<ExtractExperienceResult> {
  const llm = new ResponsesCliAdapter();
  try {
    return await extractExperienceWithLlmForTest(options, llm);
  } finally {
    await llm.close();
  }
}

/** @internal fake LLM 회귀 테스트 전용 seam. 제품 CLI는 이 함수를 import하지 않는다. */
export async function extractExperienceWithLlmForTest(options: ExtractExperienceOptions, llm: LlmCli): Promise<ExtractExperienceResult> {
  const startedAt = performance.now();
  const project = options.project.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) throw new Error(`잘못된 project 이름입니다: ${project}`);
  const source = await readCurrentSource(options.dataDir, project);
  const selected = selectPackets(source.packets, options);
  const successfulPacketIds: string[] = [];
  const failedPacketIds: string[] = [];
  const memories: MemoryRecord[] = [];
  const errors: Array<{ packetId: string; error: string }> = [];
  let calls = 0;
  let cacheHits = 0;

  // 의도적으로 순차 처리한다. Memory 추출 concurrency는 코드에서 1로 고정하며 옵션으로 노출하지 않는다.
  for (const packet of selected.packets) {
    const identity: ExtractionCacheIdentity = {
      contentHash: packet.contentHash,
      promptVersion: EXPERIENCE_PROMPT_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      model: MEMORY_EXTRACTION_MODEL,
      effort: MEMORY_EXTRACTION_EFFORT,
    };
    try {
      let output = await readExtractionCache(options.dataDir, project, identity);
      const cacheMiss = output === undefined;
      if (output) {
        cacheHits += 1;
      } else {
        calls += 1;
        const result = await llm.complete(buildExperiencePrompt(packet), {
          model: MEMORY_EXTRACTION_MODEL,
          effort: MEMORY_EXTRACTION_EFFORT,
          outputSchema: EXPERIENCE_OUTPUT_JSON_SCHEMA,
        });
        output = parseLlmOutput(packet.id, result.text);
      }
      const resolved = resolveDrafts(packet, output);
      if (cacheMiss) {
        await writeExtractionCache(options.dataDir, project, identity, output);
      }
      memories.push(...resolved);
      successfulPacketIds.push(packet.id);
    } catch (error) {
      failedPacketIds.push(packet.id);
      errors.push({ packetId: packet.id, error: errorMessage(error) });
    }
  }

  successfulPacketIds.sort(compareText);
  failedPacketIds.sort(compareText);
  errors.sort((left, right) => compareText(left.packetId, right.packetId));
  const complete = selected.selection.mode === "all" && failedPacketIds.length === 0;
  const generation = await publishExtractionGeneration(
    options.dataDir,
    {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      project,
      sourceGenerationId: source.sourceGenerationId,
      sourceManifestHash: source.sourceManifestHash,
      selection: selected.selection,
      successfulPacketIds,
      failedPacketIds,
      model: MEMORY_EXTRACTION_MODEL,
      effort: MEMORY_EXTRACTION_EFFORT,
      promptVersion: EXPERIENCE_PROMPT_VERSION,
      complete,
    },
    memories,
  );
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  const run = await publishExtractionRun(options.dataDir, {
    project,
    sourceGenerationId: source.sourceGenerationId,
    extractionGenerationId: generation.manifest.extractionGenerationId,
    selectedPackets: selected.packets.length,
    succeededPackets: successfulPacketIds.length,
    failedPackets: failedPacketIds.length,
    memories: memories.length,
    calls,
    cacheHits,
    elapsedMs,
    errors,
  });
  return {
    project,
    sourceGenerationId: source.sourceGenerationId,
    extractionGenerationId: generation.manifest.extractionGenerationId,
    generationDirectory: generation.generationDirectory,
    runId: run.report.runId,
    runDirectory: run.runDirectory,
    complete,
    selectedPackets: selected.packets.length,
    succeededPackets: successfulPacketIds.length,
    failedPackets: failedPacketIds.length,
    memories: memories.length,
    calls,
    cacheHits,
  };
}
