import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { MEMORY_SCHEMA_VERSION, sourceRefKey, type EvidencePacket, type SourceRef } from "@devloop/shared";
import { compareText, packetWithContentHash } from "./evidence-serialization";

export const GIT_DIFF_CHARACTER_LIMIT = 12_000;

export type GitCommandRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export interface GitRepositorySnapshot {
  name: string;
  remoteUrl: string;
  revision: string;
}

export interface GitSourceResult {
  repositories: GitRepositorySnapshot[];
  packets: EvidencePacket[];
}

export async function executeGitCommand(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} 실패: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizeRemoteUrl(remote: string): string {
  const trimmed = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (/^https?:\/\//.test(trimmed)) return trimmed;

  const scpLike = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`;

  const ssh = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  throw new Error(`origin remote를 HTTP URL로 정규화할 수 없습니다: ${remote.trim()}`);
}

function repositoryIdentity(remoteUrl: string): string {
  const url = new URL(remoteUrl);
  const repositoryPath = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!repositoryPath) throw new Error(`origin remote에 저장소 경로가 없습니다: ${remoteUrl}`);
  return path.posix.basename(repositoryPath);
}

function encodedRepositoryPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function isGeneratedPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const name = path.posix.basename(normalized);
  return (
    normalized.startsWith("dist/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("build/") ||
    normalized.includes("/build/") ||
    normalized.startsWith("coverage/") ||
    normalized.includes("/coverage/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/") ||
    name === "package-lock.json" ||
    name === "pnpm-lock.yaml" ||
    name === "yarn.lock" ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    name.includes(".generated.")
  );
}

function isExperienceDocument(filePath: string): boolean {
  return (
    filePath === "README.md" || filePath === "CLAUDE.md" || filePath === "AGENTS.md" || (filePath.startsWith("docs/") && filePath.endsWith(".md"))
  );
}

function parseNumstat(output: string): string[] {
  const paths: string[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const [added, deleted, ...pathParts] = record.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath || added === "-" || deleted === "-" || isGeneratedPath(filePath)) continue;
    paths.push(filePath);
  }
  return [...new Set(paths)].sort(compareText);
}

function boundedDiff(diff: string): string {
  if (diff.length <= GIT_DIFF_CHARACTER_LIMIT) return diff.trim();
  const marker = `\n[diff truncated at ${GIT_DIFF_CHARACTER_LIMIT} characters]`;
  return `${diff.slice(0, GIT_DIFF_CHARACTER_LIMIT - marker.length).trimEnd()}${marker}`;
}

async function gitRepositories(gitRoot: string): Promise<{ directoryName: string; localPath: string }[]> {
  let entries;
  try {
    entries = await readdir(gitRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Git root ${gitRoot}: 읽을 수 없습니다. ${(error as Error).message}`);
  }

  const repositories: { directoryName: string; localPath: string }[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) continue;
    const localPath = path.join(gitRoot, entry.name);
    try {
      await lstat(path.join(localPath, ".git"));
      repositories.push({ directoryName: entry.name, localPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (repositories.length === 0) throw new Error(`Git root ${gitRoot}: 직계 하위 Git 저장소가 없습니다.`);
  return repositories;
}

async function commitPacket(
  runner: GitCommandRunner,
  project: string,
  repository: string,
  localPath: string,
  remoteUrl: string,
  revision: string,
): Promise<EvidencePacket> {
  const metadata = await runner(localPath, ["show", "-s", "--format=%cI%n%B", revision]);
  const [occurredAtLine = "", ...messageLines] = metadata.replace(/\r\n?/g, "\n").split("\n");
  const message = messageLines.join("\n").trim();
  if (!message) throw new Error(`commit ${revision}: message가 없습니다.`);

  const numstat = await runner(localPath, ["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "--numstat", "-z", revision]);
  const changedPaths = parseNumstat(numstat);
  const diff = changedPaths.length
    ? boundedDiff(await runner(localPath, ["show", "--format=", "--no-ext-diff", "--no-renames", "--unified=3", revision, "--", ...changedPaths]))
    : "";
  const sourceId = `${repository}@${revision}`;
  const title = message.split("\n", 1)[0] ?? revision;
  const ref: SourceRef = {
    sourceType: "git-commit",
    sourceId,
    repository,
    revision,
    title,
    url: `${remoteUrl}/commit/${revision}`,
    ...(occurredAtLine ? { occurredAt: new Date(occurredAtLine).toISOString() } : {}),
  };
  const key = sourceRefKey(ref);
  const segments = [
    { sourceRefKey: key, text: `Commit message:\n${message}` },
    ...(changedPaths.length ? [{ sourceRefKey: key, text: `Changed paths:\n${changedPaths.join("\n")}` }] : []),
    ...(diff ? [{ sourceRefKey: key, text: `Diff:\n${diff}` }] : []),
  ];

  return packetWithContentHash({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `git-commit:${sourceId}`,
    project,
    sourceKind: "git-commit",
    title,
    scope: { project, repositories: [repository], paths: changedPaths },
    segments,
    sourceRefs: [ref],
  });
}

async function filePacket(
  runner: GitCommandRunner,
  project: string,
  repository: string,
  localPath: string,
  remoteUrl: string,
  revision: string,
  filePath: string,
): Promise<EvidencePacket | undefined> {
  const text = (await runner(localPath, ["show", `${revision}:${filePath}`])).replace(/\r\n?/g, "\n").trim();
  if (!text) return undefined;
  const sourceId = `${repository}@${revision}:${filePath}`;
  const ref: SourceRef = {
    sourceType: "git-file",
    sourceId,
    repository,
    revision,
    path: filePath,
    title: `${repository}/${filePath}`,
    url: `${remoteUrl}/blob/${revision}/${encodedRepositoryPath(filePath)}`,
  };

  return packetWithContentHash({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `git-file:${sourceId}`,
    project,
    sourceKind: "git-file",
    title: ref.title,
    scope: { project, repositories: [repository], paths: [filePath] },
    segments: [{ sourceRefKey: sourceRefKey(ref), text }],
    sourceRefs: [ref],
  });
}

async function normalizeRepository(
  runner: GitCommandRunner,
  project: string,
  repository: { directoryName: string; localPath: string },
): Promise<{ snapshot: GitRepositorySnapshot; packets: EvidencePacket[] }> {
  try {
    const revision = (await runner(repository.localPath, ["rev-parse", "--verify", "origin/HEAD^{commit}"])).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`origin/HEAD가 40자 commit SHA가 아닙니다: ${revision}`);
    const remoteUrl = normalizeRemoteUrl(await runner(repository.localPath, ["remote", "get-url", "origin"]));
    const repositoryName = repositoryIdentity(remoteUrl);
    const commitRevisions = (await runner(repository.localPath, ["rev-list", "--no-merges", revision]))
      .split(/\r?\n/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const treePaths = (await runner(repository.localPath, ["ls-tree", "-r", "--name-only", "-z", revision]))
      .split("\0")
      .filter(isExperienceDocument)
      .sort(compareText);

    const packets: EvidencePacket[] = [];
    for (const commitRevision of commitRevisions) {
      packets.push(await commitPacket(runner, project, repositoryName, repository.localPath, remoteUrl, commitRevision));
    }
    for (const filePath of treePaths) {
      const packet = await filePacket(runner, project, repositoryName, repository.localPath, remoteUrl, revision, filePath);
      if (packet) packets.push(packet);
    }
    packets.sort((left, right) => compareText(left.id, right.id));
    return { snapshot: { name: repositoryName, remoteUrl, revision }, packets };
  } catch (error) {
    throw new Error(`Git repository ${repository.directoryName}: ${(error as Error).message}`);
  }
}

export async function normalizeGitSource(gitRoot: string, project: string, runner: GitCommandRunner = executeGitCommand): Promise<GitSourceResult> {
  const repositories = await gitRepositories(gitRoot);
  const snapshots: GitRepositorySnapshot[] = [];
  const packets: EvidencePacket[] = [];
  const localDirectoryByIdentity = new Map<string, string>();
  for (const repository of repositories) {
    const result = await normalizeRepository(runner, project, repository);
    const previousDirectory = localDirectoryByIdentity.get(result.snapshot.name);
    if (previousDirectory) {
      throw new Error(`Git repository canonical identity 중복: ${result.snapshot.name} (${previousDirectory}, ${repository.directoryName})`);
    }
    localDirectoryByIdentity.set(result.snapshot.name, repository.directoryName);
    snapshots.push(result.snapshot);
    packets.push(...result.packets);
  }
  packets.sort((left, right) => compareText(left.id, right.id));
  return { repositories: snapshots, packets };
}
