import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_CACHE_DIRECTORY, MEMORY_SCHEMA_VERSION } from "@devloop/shared";
import { z } from "zod";
import { canonicalString, hashCanonical } from "./evidence-serialization";
import { ExperienceExtractionOutputSchema, type ExperienceExtractionOutput } from "./experience-extraction.schema";

export const ExtractionCacheIdentitySchema = z
  .object({
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    promptVersion: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    model: z.string().min(1),
    effort: z.string().min(1),
  })
  .strict();
export type ExtractionCacheIdentity = z.infer<typeof ExtractionCacheIdentitySchema>;

const ExtractionCacheEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    cacheKey: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    identity: ExtractionCacheIdentitySchema,
    output: ExperienceExtractionOutputSchema,
  })
  .strict();

function cachePath(dataDir: string, project: string, cacheKey: string): string {
  return path.join(dataDir, "memory", project, MEMORY_CACHE_DIRECTORY, `${cacheKey.slice("sha256:".length)}.json`);
}

export function extractionCacheKey(identityInput: ExtractionCacheIdentity): string {
  return hashCanonical(ExtractionCacheIdentitySchema.parse(identityInput));
}

export async function readExtractionCache(
  dataDir: string,
  project: string,
  identityInput: ExtractionCacheIdentity,
): Promise<ExperienceExtractionOutput | undefined> {
  const identity = ExtractionCacheIdentitySchema.parse(identityInput);
  const cacheKey = extractionCacheKey(identity);
  let text: string;
  try {
    text = await readFile(cachePath(dataDir, project, cacheKey), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const envelope = ExtractionCacheEnvelopeSchema.parse(JSON.parse(text) as unknown);
  if (envelope.cacheKey !== cacheKey || canonicalString(envelope.identity) !== canonicalString(identity)) {
    throw new Error(`Experience extraction cache identity가 일치하지 않습니다: ${cacheKey}`);
  }
  return ExperienceExtractionOutputSchema.parse(envelope.output);
}

export async function writeExtractionCache(
  dataDir: string,
  project: string,
  identityInput: ExtractionCacheIdentity,
  outputInput: ExperienceExtractionOutput,
): Promise<void> {
  const identity = ExtractionCacheIdentitySchema.parse(identityInput);
  const output = ExperienceExtractionOutputSchema.parse(outputInput);
  const cacheKey = extractionCacheKey(identity);
  const destination = cachePath(dataDir, project, cacheKey);
  const directory = path.dirname(destination);
  const text = `${canonicalString({ schemaVersion: MEMORY_SCHEMA_VERSION, cacheKey, identity, output })}\n`;
  const temporary = path.join(directory, `.tmp-${cacheKey.slice("sha256:".length)}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(destination, "utf8");
      if (existing !== text) throw new Error(`immutable Experience extraction cache byte가 다릅니다: ${destination}`);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
