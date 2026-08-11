import { MEMORY_SCHEMA_VERSION } from "@devloop/shared";
import { normalizeProjectCode } from "../cli-options";
import { normalizeDooraySource } from "./dooray-source";
import { compareText, hashCanonical } from "./evidence-serialization";
import { normalizeGitSource, type GitCommandRunner } from "./git-source";
import { publishSourceGeneration, SourceManifestSchema, type SourceManifest } from "./source-generation-publisher";

export interface NormalizeEvidenceOptions {
  project: string;
  gitRoot: string;
  dataDir: string;
  gitRunner?: GitCommandRunner;
}

export interface NormalizeEvidenceResult {
  project: string;
  sourceGenerationId: string;
  generationDir: string;
  manifest: SourceManifest;
  packets: number;
  segments: number;
  sourceRefs: number;
}

export async function normalizeEvidence(options: NormalizeEvidenceOptions): Promise<NormalizeEvidenceResult> {
  const project = normalizeProjectCode(options.project);

  // 원천 하나라도 실패하면 generation publication을 시작하지 않는다.
  const [dooray, git] = await Promise.all([
    normalizeDooraySource(options.dataDir, project),
    normalizeGitSource(options.gitRoot, project, options.gitRunner),
  ]);
  const gitRepositories = [...git.repositories].sort((left, right) => compareText(left.name, right.name));
  const sourceIdentity = {
    doorayContentHash: dooray.contentHash,
    gitRepositories: gitRepositories.map(({ name, remoteUrl, revision }) => ({ name, remoteUrl, revision })),
  };
  const sourceGenerationId = `src-${hashCanonical(sourceIdentity).slice("sha256:".length)}`;
  const manifest = SourceManifestSchema.parse({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    project,
    sourceGenerationId,
    dooray: { contentHash: dooray.contentHash, ...dooray.counts },
    gitRepositories,
  });
  const packets = [...dooray.packets, ...git.packets].sort((left, right) => compareText(left.id, right.id));
  const generationDir = await publishSourceGeneration(options.dataDir, manifest, packets);

  return {
    project,
    sourceGenerationId,
    generationDir,
    manifest,
    packets: packets.length,
    segments: packets.reduce((sum, packet) => sum + packet.segments.length, 0),
    sourceRefs: packets.reduce((sum, packet) => sum + packet.sourceRefs.length, 0),
  };
}
