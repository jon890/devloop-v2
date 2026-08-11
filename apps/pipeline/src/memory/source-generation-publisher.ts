import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_SOURCE_POINTER_FILE,
  EVIDENCE_FILE,
  EvidencePacketSchema,
  MEMORY_SCHEMA_VERSION,
  SOURCE_GENERATIONS_DIRECTORY,
  SOURCE_MANIFEST_FILE,
  sourceRefKey,
  type EvidencePacket,
} from "@devloop/shared";
import { z } from "zod";
import { canonicalString, hashCanonical } from "./evidence-serialization";

export const SourceManifestSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  sourceGenerationId: z.string().regex(/^src-[0-9a-f]{64}$/),
  dooray: z.object({
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    tasks: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    wikis: z.number().int().nonnegative(),
  }),
  gitRepositories: z.array(
    z.object({
      name: z.string().min(1),
      remoteUrl: z
        .string()
        .url()
        .refine((value) => value.startsWith("https://") || value.startsWith("http://"), "HTTP URL이어야 합니다."),
      revision: z.string().regex(/^[0-9a-f]{40}$/),
    }),
  ),
});
export type SourceManifest = z.infer<typeof SourceManifestSchema>;

export const SourcePointerSchema = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  generationId: z.string().regex(/^src-[0-9a-f]{64}$/),
});

function packetBody(packet: EvidencePacket): Omit<EvidencePacket, "contentHash"> {
  const { contentHash: _contentHash, ...body } = packet;
  return body;
}

export function validateEvidenceJsonl(evidence: string): EvidencePacket[] {
  const packets = evidence
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`${EVIDENCE_FILE}:${index + 1} invalid JSONL: ${(error as Error).message}`);
      }
      const packet = EvidencePacketSchema.parse(parsed);
      const expectedHash = hashCanonical(packetBody(packet));
      if (packet.contentHash !== expectedHash) {
        throw new Error(`${EVIDENCE_FILE}:${index + 1} contentHash 불일치: ${packet.id}`);
      }
      return packet;
    });

  const ids = new Set<string>();
  const sourceRefKeys = new Set<string>();
  for (const packet of packets) {
    if (ids.has(packet.id)) throw new Error(`${EVIDENCE_FILE}: 중복 packet ID ${packet.id}`);
    ids.add(packet.id);
    for (const ref of packet.sourceRefs) {
      const key = sourceRefKey(ref);
      if (sourceRefKeys.has(key)) throw new Error(`${EVIDENCE_FILE}: 여러 packet에 중복 SourceRef ${key}`);
      sourceRefKeys.add(key);
    }
  }
  return packets;
}

async function validateGeneration(directory: string, expectedManifest: string, expectedEvidence: string): Promise<void> {
  const [manifestText, evidenceText] = await Promise.all([
    readFile(path.join(directory, SOURCE_MANIFEST_FILE), "utf8"),
    readFile(path.join(directory, EVIDENCE_FILE), "utf8"),
  ]);
  SourceManifestSchema.parse(JSON.parse(manifestText) as unknown);
  validateEvidenceJsonl(evidenceText);
  if (manifestText !== expectedManifest || evidenceText !== expectedEvidence) {
    throw new Error(`immutable source generation의 기존 byte가 기대값과 다릅니다: ${directory}`);
  }
}

async function installGeneration(directory: string, manifest: string, evidence: string): Promise<void> {
  const temporary = path.join(path.dirname(directory), `.tmp-${path.basename(directory)}-${randomUUID()}`);
  await mkdir(temporary, { recursive: false });
  try {
    await Promise.all([
      writeFile(path.join(temporary, SOURCE_MANIFEST_FILE), manifest, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(temporary, EVIDENCE_FILE), evidence, { encoding: "utf8", flag: "wx" }),
    ]);
    await validateGeneration(temporary, manifest, evidence);
    try {
      await rename(temporary, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await validateGeneration(directory, manifest, evidence);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function replacePointer(projectDirectory: string, sourceGenerationId: string): Promise<void> {
  const pointer = `${canonicalString({ schemaVersion: MEMORY_SCHEMA_VERSION, generationId: sourceGenerationId })}\n`;
  const temporary = path.join(projectDirectory, `.${CURRENT_SOURCE_POINTER_FILE}.tmp-${randomUUID()}`);
  await writeFile(temporary, pointer, { encoding: "utf8", flag: "wx" });
  try {
    SourcePointerSchema.parse(JSON.parse(await readFile(temporary, "utf8")) as unknown);
    await rename(temporary, path.join(projectDirectory, CURRENT_SOURCE_POINTER_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishSourceGeneration(dataDir: string, manifestInput: SourceManifest, packets: readonly EvidencePacket[]): Promise<string> {
  const manifest = SourceManifestSchema.parse(manifestInput);
  const manifestText = `${canonicalString(manifest)}\n`;
  const evidenceText = packets.length ? `${packets.map(canonicalString).join("\n")}\n` : "";
  validateEvidenceJsonl(evidenceText);

  const projectDirectory = path.join(dataDir, "memory", manifest.project);
  const generationsDirectory = path.join(projectDirectory, SOURCE_GENERATIONS_DIRECTORY);
  const generationDirectory = path.join(generationsDirectory, manifest.sourceGenerationId);
  await mkdir(generationsDirectory, { recursive: true });
  await installGeneration(generationDirectory, manifestText, evidenceText);
  await replacePointer(projectDirectory, manifest.sourceGenerationId);
  return generationDirectory;
}
