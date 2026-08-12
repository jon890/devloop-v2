import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_EXTRACTION_POINTER_FILE,
  EXTRACTED_FILE,
  EXTRACTION_GENERATIONS_DIRECTORY,
  EXTRACTION_MANIFEST_FILE,
  MEMORY_SCHEMA_VERSION,
  MemoryRecordSchema,
  type MemoryRecord,
  type SourceRef,
} from "@devloop/shared";
import { z } from "zod";
import { normalizeProjectCode } from "../cli-options";
import { ExtractionManifestSchema } from "./extraction-generation-publisher";
import { canonicalString, compareText, hashCanonical, sha256 } from "./evidence-serialization";

export const WIKI_GENERATIONS_DIRECTORY = "wiki-generations";
export const CURRENT_WIKI_POINTER_FILE = "current-wiki.json";
export const WIKI_INDEX_FILE = "index.json";
export const WIKI_ROOT_INDEX_FILE = "index.md";
export const MEMORY_KIND_DIRECTORIES = {
  decision: "decisions",
  constraint: "constraints",
  incident: "incidents",
  "failed-attempt": "failed-attempts",
  lesson: "lessons",
} as const satisfies Record<MemoryRecord["kind"], string>;

const WikiPointerSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    generationId: z.string().regex(/^wiki-[0-9a-f]{64}$/),
  })
  .strict();

export const WikiIndexEntrySchema = z
  .object({
    id: z.string().regex(/^mem-[0-9a-f]{64}$/),
    title: z.string().min(1),
    kind: z.string().min(1),
    status: z.string().min(1),
    confidence: z.string().min(1),
    summary: z.string().min(1),
    why: z.string().min(1),
    doNot: z.array(z.string().min(1)),
    scope: z
      .object({
        project: z.string().min(1),
        repositories: z.array(z.string().min(1)),
        modules: z.array(z.string().min(1)),
        paths: z.array(z.string().min(1)),
      })
      .strict(),
    relatedTerms: z.array(z.string().min(1)),
    sourceRefs: z
      .array(z.object({ sourceType: z.string().min(1), sourceId: z.string().min(1), url: z.string().url(), title: z.string().min(1) }).passthrough())
      .min(1),
    markdownPath: z.string().min(1),
    normalized: z.object({ title: z.string(), relatedTerms: z.array(z.string()), summary: z.string(), why: z.string(), scope: z.string() }).strict(),
    record: MemoryRecordSchema,
  })
  .strict();
export type WikiIndexEntry = z.infer<typeof WikiIndexEntrySchema>;

export const WikiIndexSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    project: z.string().min(1),
    wikiGenerationId: z.string().regex(/^wiki-[0-9a-f]{64}$/),
    extractionGenerationId: z.string().regex(/^ext-[0-9a-f]{64}$/),
    sourceGenerationId: z.string().regex(/^src-[0-9a-f]{64}$/),
    sourceManifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    extractionManifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    complete: z.boolean(),
    documents: z.array(WikiIndexEntrySchema),
  })
  .strict();
export type WikiIndex = z.infer<typeof WikiIndexSchema>;

export interface BuildMemoryWikiOptions {
  project: string;
  dataDir: string;
  allowIncomplete?: boolean;
}

export interface BuildMemoryWikiResult {
  project: string;
  complete: boolean;
  memories: number;
  extractionGenerationId: string;
  wikiGenerationId: string;
  generationDirectory: string;
}

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
  return records.sort((left, right) => compareText(left.id, right.id));
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r", "").replaceAll("\n", " ");
}

function slugify(title: string): string {
  const slug = normalizeSearchText(title)
    .replace(/[^a-z0-9가-힣._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "memory";
}

function sourceRefLine(ref: SourceRef): string {
  const label = markdownEscape(`${ref.title} (${ref.sourceType}:${ref.sourceId})`);
  return `- [${label}](${ref.url})`;
}

function scopeText(record: MemoryRecord): string {
  const parts = [
    `project=${record.scope.project}`,
    record.scope.repositories.length ? `repositories=${record.scope.repositories.join(", ")}` : undefined,
    record.scope.modules.length ? `modules=${record.scope.modules.join(", ")}` : undefined,
    record.scope.paths.length ? `paths=${record.scope.paths.join(", ")}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return parts.join("; ");
}

function markdown(record: MemoryRecord): string {
  const doNot = record.doNot.length ? `\n## Do Not\n\n${record.doNot.map((value) => `- ${markdownEscape(value)}`).join("\n")}\n` : "";
  return [
    `# ${markdownEscape(record.title)}`,
    "",
    `- status: ${record.status}`,
    `- confidence: ${record.confidence}`,
    `- scope: ${markdownEscape(scopeText(record))}`,
    "",
    "## Summary",
    "",
    record.summary,
    "",
    "## Why",
    "",
    record.why,
    doNot.trimEnd(),
    "",
    "## Sources",
    "",
    record.sourceRefs.map(sourceRefLine).join("\n"),
    "",
  ]
    .filter((value) => value !== "")
    .join("\n");
}

function filenameById(records: readonly MemoryRecord[]): Map<string, string> {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const slug = slugify(record.title);
    groups.set(slug, [...(groups.get(slug) ?? []), record]);
  }
  const filenames = new Map<string, string>();
  for (const [slug, group] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    const sorted = group.sort((left, right) => compareText(left.id, right.id));
    for (const record of sorted) {
      const suffix = sorted.length === 1 ? "" : `-${record.id.slice("mem-".length, "mem-".length + 12)}`;
      filenames.set(record.id, `${MEMORY_KIND_DIRECTORIES[record.kind]}/${slug}${suffix}.md`);
    }
  }
  return filenames;
}

function indexEntry(record: MemoryRecord, markdownPath: string): WikiIndexEntry {
  return WikiIndexEntrySchema.parse({
    id: record.id,
    title: record.title,
    kind: record.kind,
    status: record.status,
    confidence: record.confidence,
    summary: record.summary,
    why: record.why,
    doNot: record.doNot,
    scope: record.scope,
    relatedTerms: record.relatedTerms,
    sourceRefs: record.sourceRefs,
    markdownPath,
    normalized: {
      title: normalizeSearchText(record.title),
      relatedTerms: record.relatedTerms.map(normalizeSearchText),
      summary: normalizeSearchText(record.summary),
      why: normalizeSearchText(record.why),
      scope: normalizeSearchText(scopeText(record)),
    },
    record,
  });
}

function rootIndex(documents: readonly WikiIndexEntry[]): string {
  const lines = ["# Experience Memory", ""];
  let currentKind = "";
  for (const document of documents) {
    if (document.kind !== currentKind) {
      currentKind = document.kind;
      lines.push(`## ${currentKind}`, "");
    }
    lines.push(`- [${markdownEscape(document.title)}](${document.markdownPath}) — ${document.status}, ${document.confidence}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function readCurrentExtraction(dataDir: string, project: string): Promise<{ manifestText: string; extractedText: string }> {
  const projectDirectory = path.join(dataDir, "memory", project);
  const pointer = z
    .object({ schemaVersion: z.literal(MEMORY_SCHEMA_VERSION), generationId: z.string().regex(/^ext-[0-9a-f]{64}$/) })
    .strict()
    .parse(JSON.parse(await readFile(path.join(projectDirectory, CURRENT_EXTRACTION_POINTER_FILE), "utf8")) as unknown);
  const generationDirectory = path.join(projectDirectory, EXTRACTION_GENERATIONS_DIRECTORY, pointer.generationId);
  const [manifestText, extractedText] = await Promise.all([
    readFile(path.join(generationDirectory, EXTRACTION_MANIFEST_FILE), "utf8"),
    readFile(path.join(generationDirectory, EXTRACTED_FILE), "utf8"),
  ]);
  return { manifestText, extractedText };
}

async function replacePointer(projectDirectory: string, generationId: string): Promise<void> {
  const text = `${canonicalString({ schemaVersion: MEMORY_SCHEMA_VERSION, generationId })}\n`;
  const temporary = path.join(projectDirectory, `.${CURRENT_WIKI_POINTER_FILE}.tmp-${randomUUID()}`);
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    WikiPointerSchema.parse(JSON.parse(await readFile(temporary, "utf8")) as unknown);
    await rename(temporary, path.join(projectDirectory, CURRENT_WIKI_POINTER_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeGeneration(directory: string, files: ReadonlyMap<string, string>, index: WikiIndex): Promise<void> {
  const temporary = path.join(path.dirname(directory), `.tmp-${path.basename(directory)}-${randomUUID()}`);
  await mkdir(temporary, { recursive: false });
  try {
    for (const [relativePath, text] of [...files].sort(([left], [right]) => compareText(left, right))) {
      const destination = path.join(temporary, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text, { encoding: "utf8", flag: "wx" });
    }
    WikiIndexSchema.parse(JSON.parse(await readFile(path.join(temporary, WIKI_INDEX_FILE), "utf8")) as unknown);
    try {
      await rename(temporary, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const existing = WikiIndexSchema.parse(JSON.parse(await readFile(path.join(directory, WIKI_INDEX_FILE), "utf8")) as unknown);
      if (canonicalString(existing) !== canonicalString(index))
        throw new Error(`immutable wiki generation의 기존 byte가 기대값과 다릅니다: ${directory}`);
      for (const [relativePath, text] of files) {
        if ((await readFile(path.join(directory, relativePath), "utf8")) !== text) {
          throw new Error(`immutable wiki generation의 기존 byte가 기대값과 다릅니다: ${path.join(directory, relativePath)}`);
        }
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withBuildLock<T>(projectDirectory: string, action: () => Promise<T>): Promise<T> {
  const lockDirectory = path.join(projectDirectory, ".current-wiki.lock");
  await mkdir(lockDirectory, { recursive: false });
  try {
    return await action();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export async function buildMemoryWiki(options: BuildMemoryWikiOptions): Promise<BuildMemoryWikiResult> {
  const project = normalizeProjectCode(options.project);
  const projectDirectory = path.join(options.dataDir, "memory", project);
  await mkdir(projectDirectory, { recursive: true });
  return withBuildLock(projectDirectory, async () => {
    const { manifestText, extractedText } = await readCurrentExtraction(options.dataDir, project);
    const extractionManifest = ExtractionManifestSchema.parse(JSON.parse(manifestText) as unknown);
    if (extractionManifest.project !== project) throw new Error(`current extraction manifest의 project가 요청과 다릅니다: ${project}`);
    if (!extractionManifest.complete && !options.allowIncomplete)
      throw new Error("incomplete extraction은 --allow-incomplete 없이는 Wiki로 만들 수 없습니다.");
    if (extractionManifest.resultContentHash !== sha256(extractedText))
      throw new Error(`${EXTRACTION_MANIFEST_FILE}: resultContentHash가 ${EXTRACTED_FILE}과 다릅니다.`);

    const memories = parseExtracted(extractedText);
    const filenames = filenameById(memories);
    const documents = memories
      .map((record) => indexEntry(record, filenames.get(record.id) ?? `${record.kind}/${record.id}.md`))
      .sort((left, right) => compareText(left.kind, right.kind) || compareText(left.title, right.title) || compareText(left.id, right.id));
    const body = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      project,
      extractionGenerationId: extractionManifest.extractionGenerationId,
      sourceGenerationId: extractionManifest.sourceGenerationId,
      sourceManifestHash: extractionManifest.sourceManifestHash,
      extractionManifestHash: sha256(manifestText),
      complete: extractionManifest.complete,
      documents,
    };
    const wikiGenerationId = `wiki-${hashCanonical(body).slice("sha256:".length)}`;
    const index = WikiIndexSchema.parse({ ...body, wikiGenerationId });
    const files = new Map<string, string>([
      [WIKI_INDEX_FILE, `${canonicalString(index)}\n`],
      [WIKI_ROOT_INDEX_FILE, rootIndex(documents)],
    ]);
    for (const document of documents) {
      files.set(document.markdownPath, markdown(document.record));
    }

    const generationsDirectory = path.join(projectDirectory, WIKI_GENERATIONS_DIRECTORY);
    const generationDirectory = path.join(generationsDirectory, wikiGenerationId);
    await mkdir(generationsDirectory, { recursive: true });
    await writeGeneration(generationDirectory, files, index);
    await replacePointer(projectDirectory, wikiGenerationId);
    return {
      project,
      complete: index.complete,
      memories: index.documents.length,
      extractionGenerationId: index.extractionGenerationId,
      wikiGenerationId,
      generationDirectory,
    };
  });
}

async function readCurrentWikiIndexText(dataDir: string, project: string): Promise<string> {
  const projectCode = normalizeProjectCode(project);
  const projectDirectory = path.join(dataDir, "memory", projectCode);
  const pointer = WikiPointerSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, CURRENT_WIKI_POINTER_FILE), "utf8")) as unknown);
  return readFile(path.join(projectDirectory, WIKI_GENERATIONS_DIRECTORY, pointer.generationId, WIKI_INDEX_FILE), "utf8");
}

export async function readCurrentWikiIndex(dataDir: string, project: string): Promise<WikiIndex> {
  return WikiIndexSchema.parse(JSON.parse(await readCurrentWikiIndexText(dataDir, project)) as unknown);
}

export async function readCurrentWikiIndexWithHash(dataDir: string, project: string): Promise<{ index: WikiIndex; memoryIndexHash: string }> {
  const indexText = await readCurrentWikiIndexText(dataDir, project);
  return {
    index: WikiIndexSchema.parse(JSON.parse(indexText) as unknown),
    memoryIndexHash: sha256(indexText),
  };
}
