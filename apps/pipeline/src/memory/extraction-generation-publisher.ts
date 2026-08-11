import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_EXTRACTION_POINTER_FILE,
  EXTRACTED_FILE,
  EXTRACTION_GENERATIONS_DIRECTORY,
  EXTRACTION_MANIFEST_FILE,
  EXTRACTION_RUN_REPORT_FILE,
  EXTRACTION_RUNS_DIRECTORY,
  LATEST_EXTRACTION_RUN_POINTER_FILE,
  MEMORY_SCHEMA_VERSION,
  MemoryRecordSchema,
  type MemoryRecord,
} from "@devloop/shared";
import { z } from "zod";
import { canonicalString, compareText, hashCanonical, sha256 } from "./evidence-serialization";

export const ExtractionSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("limit"), limit: z.number().int().positive() }).strict(),
  z.object({ mode: z.literal("ids"), ids: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ mode: z.literal("sample-per-source"), samplePerSource: z.number().int().positive() }).strict(),
]);
export type ExtractionSelection = z.infer<typeof ExtractionSelectionSchema>;

const ExtractionManifestBodySchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    sourceGenerationId: z.string().regex(/^src-[0-9a-f]{64}$/),
    sourceManifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    selection: ExtractionSelectionSchema,
    successfulPacketIds: z.array(z.string().min(1)),
    failedPacketIds: z.array(z.string().min(1)),
    resultContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    model: z.string().min(1),
    effort: z.string().min(1),
    promptVersion: z.string().min(1),
    complete: z.boolean(),
  })
  .strict();
export type ExtractionManifestBody = z.infer<typeof ExtractionManifestBodySchema>;

export const ExtractionManifestSchema = ExtractionManifestBodySchema.extend({
  extractionGenerationId: z.string().regex(/^ext-[0-9a-f]{64}$/),
}).strict();
export type ExtractionManifest = z.infer<typeof ExtractionManifestSchema>;

export const ExtractionRunReportSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    runId: z.string().regex(/^run-[0-9a-f]{32}$/),
    project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    sourceGenerationId: z.string().regex(/^src-[0-9a-f]{64}$/),
    extractionGenerationId: z.string().regex(/^ext-[0-9a-f]{64}$/),
    selectedPackets: z.number().int().nonnegative(),
    succeededPackets: z.number().int().nonnegative(),
    failedPackets: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    errors: z.array(z.object({ packetId: z.string().min(1), error: z.string() }).strict()),
  })
  .strict();
export type ExtractionRunReport = z.infer<typeof ExtractionRunReportSchema>;

const ExtractionPointerSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  generationId: z.string().regex(/^ext-[0-9a-f]{64}$/),
});
const RunPointerSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  runId: z.string().regex(/^run-[0-9a-f]{32}$/),
});

function parseExtracted(text: string): MemoryRecord[] {
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return MemoryRecordSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new Error(`${EXTRACTED_FILE}:${index + 1} 검증 실패: ${(error as Error).message}`);
      }
    });
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`${EXTRACTED_FILE}: 중복 Memory ID ${record.id}`);
    ids.add(record.id);
  }
  return records;
}

async function validateGeneration(directory: string, expectedManifest: string, expectedExtracted: string): Promise<void> {
  const [manifestText, extractedText] = await Promise.all([
    readFile(path.join(directory, EXTRACTION_MANIFEST_FILE), "utf8"),
    readFile(path.join(directory, EXTRACTED_FILE), "utf8"),
  ]);
  const manifest = ExtractionManifestSchema.parse(JSON.parse(manifestText) as unknown);
  parseExtracted(extractedText);
  if (manifest.resultContentHash !== sha256(extractedText)) {
    throw new Error(`${EXTRACTION_MANIFEST_FILE}: resultContentHash가 ${EXTRACTED_FILE}과 다릅니다.`);
  }
  if (manifestText !== expectedManifest || extractedText !== expectedExtracted) {
    throw new Error(`immutable extraction generation의 기존 byte가 기대값과 다릅니다: ${directory}`);
  }
}

async function installGeneration(directory: string, manifest: string, extracted: string): Promise<void> {
  const temporary = path.join(path.dirname(directory), `.tmp-${path.basename(directory)}-${randomUUID()}`);
  await mkdir(temporary, { recursive: false });
  try {
    await Promise.all([
      writeFile(path.join(temporary, EXTRACTION_MANIFEST_FILE), manifest, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(temporary, EXTRACTED_FILE), extracted, { encoding: "utf8", flag: "wx" }),
    ]);
    await validateGeneration(temporary, manifest, extracted);
    try {
      await rename(temporary, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await validateGeneration(directory, manifest, extracted);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function replacePointer(projectDirectory: string, filename: string, value: unknown, schema: z.ZodType): Promise<void> {
  const text = `${canonicalString(value)}\n`;
  const temporary = path.join(projectDirectory, `.${filename}.tmp-${randomUUID()}`);
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    schema.parse(JSON.parse(await readFile(temporary, "utf8")) as unknown);
    await rename(temporary, path.join(projectDirectory, filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishExtractionGeneration(
  dataDir: string,
  manifestBodyInput: Omit<ExtractionManifestBody, "resultContentHash">,
  memoriesInput: readonly MemoryRecord[],
): Promise<{ generationDirectory: string; manifest: ExtractionManifest }> {
  const memories = memoriesInput.map((record) => MemoryRecordSchema.parse(record)).sort((left, right) => compareText(left.id, right.id));
  const extractedText = memories.length ? `${memories.map(canonicalString).join("\n")}\n` : "";
  parseExtracted(extractedText);
  const body = ExtractionManifestBodySchema.parse({ ...manifestBodyInput, resultContentHash: sha256(extractedText) });
  const extractionGenerationId = `ext-${hashCanonical(body).slice("sha256:".length)}`;
  const manifest = ExtractionManifestSchema.parse({ ...body, extractionGenerationId });
  const manifestText = `${canonicalString(manifest)}\n`;
  const projectDirectory = path.join(dataDir, "memory", manifest.project);
  const generationsDirectory = path.join(projectDirectory, EXTRACTION_GENERATIONS_DIRECTORY);
  const generationDirectory = path.join(generationsDirectory, extractionGenerationId);
  await mkdir(generationsDirectory, { recursive: true });
  await installGeneration(generationDirectory, manifestText, extractedText);
  await replacePointer(
    projectDirectory,
    CURRENT_EXTRACTION_POINTER_FILE,
    { schemaVersion: MEMORY_SCHEMA_VERSION, generationId: extractionGenerationId },
    ExtractionPointerSchema,
  );
  return { generationDirectory, manifest };
}

export async function publishExtractionRun(
  dataDir: string,
  reportInput: Omit<ExtractionRunReport, "schemaVersion" | "runId">,
): Promise<{ runDirectory: string; report: ExtractionRunReport }> {
  const runId = `run-${randomUUID().replaceAll("-", "")}`;
  const report = ExtractionRunReportSchema.parse({ schemaVersion: MEMORY_SCHEMA_VERSION, runId, ...reportInput });
  const projectDirectory = path.join(dataDir, "memory", report.project);
  const runsDirectory = path.join(projectDirectory, EXTRACTION_RUNS_DIRECTORY);
  const runDirectory = path.join(runsDirectory, runId);
  const temporary = path.join(runsDirectory, `.tmp-${runId}-${randomUUID()}`);
  const reportText = `${canonicalString(report)}\n`;
  await mkdir(runsDirectory, { recursive: true });
  await mkdir(temporary, { recursive: false });
  try {
    await writeFile(path.join(temporary, EXTRACTION_RUN_REPORT_FILE), reportText, { encoding: "utf8", flag: "wx" });
    ExtractionRunReportSchema.parse(JSON.parse(await readFile(path.join(temporary, EXTRACTION_RUN_REPORT_FILE), "utf8")) as unknown);
    await rename(temporary, runDirectory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await replacePointer(projectDirectory, LATEST_EXTRACTION_RUN_POINTER_FILE, { schemaVersion: MEMORY_SCHEMA_VERSION, runId }, RunPointerSchema);
  return { runDirectory, report };
}
