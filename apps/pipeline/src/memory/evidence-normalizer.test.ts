import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CURRENT_SOURCE_POINTER_FILE, EVIDENCE_FILE, SOURCE_GENERATIONS_DIRECTORY, SOURCE_MANIFEST_FILE } from "@devloop/shared";
import { hashCanonical } from "./evidence-serialization";
import { normalizeEvidence } from "./evidence-normalizer";
import { executeGitCommand, GIT_DIFF_CHARACTER_LIMIT, normalizeGitSource, type GitCommandRunner } from "./git-source";

const temporaryDirectories: string[] = [];
const OCR_API_REMOTE = "https://github.nhnent.com/TOASTCloud/OCR.API.git";
const OCR_API_REPOSITORY = "OCR.API";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function createGitFixture(
  gitRoot: string,
  directoryName = "OCR.API",
  remoteUrl = OCR_API_REMOTE,
): Promise<{ repository: string; revision: string }> {
  const repository = path.join(gitRoot, directoryName);
  await mkdir(path.join(repository, "docs"), { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Memory Test"]);
  git(repository, ["config", "user.email", "memory@example.com"]);
  await writeFile(path.join(repository, "README.md"), "pinned README\n");
  await writeFile(path.join(repository, "docs", "decision.md"), "# Decision\n\n이유를 보존한다.\n");
  await writeFile(path.join(repository, "pnpm-lock.yaml"), "generated lock\n");
  await writeFile(path.join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "경험 문서를 추가한다"]);
  const revision = git(repository, ["rev-parse", "HEAD"]).trim();
  git(repository, ["remote", "add", "origin", remoteUrl]);
  git(repository, ["update-ref", "refs/remotes/origin/main", revision]);
  git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return { repository, revision };
}

async function writeDoorayFixture(dataDir: string, reverseComments = false): Promise<void> {
  const rawDirectory = path.join(dataDir, "raw", "tc-ocr");
  await mkdir(path.join(rawDirectory, "posts"), { recursive: true });
  await mkdir(path.join(rawDirectory, "wiki"), { recursive: true });
  const comments = [
    { id: "c-2", body: { content: "둘째 댓글" } },
    { id: "c-1", body: { content: "첫째 댓글" } },
  ];
  await writeFile(
    path.join(rawDirectory, "posts", "101.json"),
    JSON.stringify({
      comments: reverseComments ? [...comments].reverse() : comments,
      post: { body: { content: "업무 본문" }, subject: "업무 제목", number: 101, id: "task-1" },
    }),
  );
  await writeFile(
    path.join(rawDirectory, "wiki", "201.json"),
    JSON.stringify({ body: { content: "위키 본문" }, subject: "위키 제목", id: "wiki-1" }),
  );
}

async function generationFile(dataDir: string, generationId: string, file: string): Promise<string> {
  return readFile(path.join(dataDir, "memory", "tc-ocr", SOURCE_GENERATIONS_DIRECTORY, generationId, file), "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Git source", () => {
  it("origin/HEAD의 commit과 file URL만 읽고 working tree와 금지 명령을 건드리지 않는다", async () => {
    const root = await temporaryDirectory("memory-git-");
    const fixture = await createGitFixture(root);
    await writeFile(path.join(fixture.repository, "README.md"), "uncommitted README\n");
    const headBefore = git(fixture.repository, ["rev-parse", "HEAD"]);
    const statusBefore = git(fixture.repository, ["status", "--porcelain=v1"]);
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (cwd, args) => {
      calls.push([...args]);
      return executeGitCommand(cwd, args);
    };

    const result = await normalizeGitSource(root, "tc-ocr", runner);
    const refs = result.packets.flatMap((packet) => packet.sourceRefs);
    const commit = refs.find((ref) => ref.sourceType === "git-commit");
    const file = refs.find((ref) => ref.sourceType === "git-file" && ref.path === "README.md");
    assert.equal(commit?.sourceId, `${OCR_API_REPOSITORY}@${fixture.revision}`);
    assert.equal(commit?.url, `https://github.nhnent.com/TOASTCloud/OCR.API/commit/${fixture.revision}`);
    assert.equal(file?.sourceId, `${OCR_API_REPOSITORY}@${fixture.revision}:README.md`);
    assert.equal(file?.url, `https://github.nhnent.com/TOASTCloud/OCR.API/blob/${fixture.revision}/README.md`);
    assert.match(result.packets.find((packet) => packet.id === `git-file:${file?.sourceId}`)?.segments[0]?.text ?? "", /pinned README/);
    assert.doesNotMatch(JSON.stringify(result.packets), /uncommitted README|generated lock|binary\.dat/);
    assert.equal(
      calls.some((args) => args.some((arg) => ["checkout", "fetch", "reset", "clean"].includes(arg))),
      false,
    );
    assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), statusBefore);
    const diffSegments = result.packets.flatMap((packet) => packet.segments).filter((segment) => segment.text.startsWith("Diff:\n"));
    assert.equal(
      diffSegments.every((segment) => segment.text.length <= GIT_DIFF_CHARACTER_LIMIT + 6),
      true,
    );
  });

  it("origin/HEAD가 없으면 저장소 이름을 포함해 hard fail한다", async () => {
    const root = await temporaryDirectory("memory-git-missing-head-");
    const repository = path.join(root, "Broken.API");
    await mkdir(repository);
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Memory Test"]);
    git(repository, ["config", "user.email", "memory@example.com"]);
    await writeFile(path.join(repository, "README.md"), "local HEAD는 있지만 origin/HEAD는 없다.\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "local only"]);
    git(repository, ["remote", "add", "origin", "https://github.nhnent.com/TOASTCloud/Broken.API.git"]);
    await assert.rejects(() => normalizeGitSource(root, "tc-ocr"), /Git repository Broken\.API:.*origin\/HEAD/);
  });

  it("origin/HEAD를 고정한 뒤 ref가 움직여도 rev-list와 evidence는 pinned SHA를 사용한다", async () => {
    const root = await temporaryDirectory("memory-git-moving-ref-");
    const fixture = await createGitFixture(root);
    await writeFile(path.join(fixture.repository, "README.md"), "moved README\n");
    git(fixture.repository, ["add", "README.md"]);
    git(fixture.repository, ["commit", "-m", "고정 뒤 생긴 commit"]);
    const movedRevision = git(fixture.repository, ["rev-parse", "HEAD"]).trim();
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (cwd, args) => {
      const result = await executeGitCommand(cwd, args);
      calls.push([...args]);
      if (args[0] === "rev-parse" && args[2] === "origin/HEAD^{commit}") {
        git(cwd, ["update-ref", "refs/remotes/origin/main", movedRevision]);
      }
      return result;
    };

    const result = await normalizeGitSource(root, "tc-ocr", runner);
    assert.equal(result.repositories[0]?.revision, fixture.revision);
    assert.equal(
      calls.some((args) => args.join(" ") === `rev-list --no-merges ${fixture.revision}`),
      true,
    );
    assert.equal(
      calls.some((args) => args.includes("origin/HEAD") && args[0] === "rev-list"),
      false,
    );
    assert.match(JSON.stringify(result.packets), /pinned README/);
    assert.doesNotMatch(JSON.stringify(result.packets), new RegExp(`moved README|${movedRevision}`));
  });

  it("같은 canonical repository identity의 checkout이 둘이면 hard fail한다", async () => {
    const root = await temporaryDirectory("memory-git-duplicate-");
    const fixture = await createGitFixture(root, "checkout-a");
    await cp(fixture.repository, path.join(root, "checkout-b"), { recursive: true });

    await assert.rejects(
      () => normalizeGitSource(root, "tc-ocr"),
      new RegExp(`canonical identity 중복: ${OCR_API_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });
});

describe("evidence normalizer", () => {
  it("입력 순서가 달라도 같은 JSONL, manifest, generation hash를 만든다", async () => {
    const gitRoot = await temporaryDirectory("memory-normalize-git-");
    await createGitFixture(gitRoot);
    const firstDataDir = await temporaryDirectory("memory-normalize-data-a-");
    const secondDataDir = await temporaryDirectory("memory-normalize-data-b-");
    await writeDoorayFixture(firstDataDir, false);
    await writeDoorayFixture(secondDataDir, true);

    const first = await normalizeEvidence({ project: "tc-ocr", gitRoot, dataDir: firstDataDir });
    const second = await normalizeEvidence({ project: "tc-ocr", gitRoot, dataDir: secondDataDir });
    assert.equal(first.sourceGenerationId, second.sourceGenerationId);
    assert.equal(
      await generationFile(firstDataDir, first.sourceGenerationId, EVIDENCE_FILE),
      await generationFile(secondDataDir, second.sourceGenerationId, EVIDENCE_FILE),
    );
    assert.equal(
      await generationFile(firstDataDir, first.sourceGenerationId, SOURCE_MANIFEST_FILE),
      await generationFile(secondDataDir, second.sourceGenerationId, SOURCE_MANIFEST_FILE),
    );
    assert.doesNotMatch(JSON.stringify(first.manifest), new RegExp(gitRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("local checkout 폴더명이 달라도 같은 remote와 revision이면 generation byte가 같다", async () => {
    const firstGitRoot = await temporaryDirectory("memory-stable-repository-a-");
    const secondGitRoot = await temporaryDirectory("memory-stable-repository-b-");
    const fixture = await createGitFixture(firstGitRoot, "checkout-a");
    await cp(fixture.repository, path.join(secondGitRoot, "checkout-b"), { recursive: true });
    const firstDataDir = await temporaryDirectory("memory-stable-data-a-");
    const secondDataDir = await temporaryDirectory("memory-stable-data-b-");
    await writeDoorayFixture(firstDataDir);
    await writeDoorayFixture(secondDataDir);

    const first = await normalizeEvidence({ project: "tc-ocr", gitRoot: firstGitRoot, dataDir: firstDataDir });
    const second = await normalizeEvidence({ project: "tc-ocr", gitRoot: secondGitRoot, dataDir: secondDataDir });
    assert.equal(first.sourceGenerationId, second.sourceGenerationId);
    assert.equal(first.manifest.gitRepositories[0]?.name, OCR_API_REPOSITORY);
    assert.equal(
      first.sourceGenerationId,
      `src-${hashCanonical({
        doorayContentHash: first.manifest.dooray.contentHash,
        gitRepositories: first.manifest.gitRepositories.map(({ name, remoteUrl, revision }) => ({ name, remoteUrl, revision })),
      }).slice("sha256:".length)}`,
    );
    assert.equal(
      await generationFile(firstDataDir, first.sourceGenerationId, EVIDENCE_FILE),
      await generationFile(secondDataDir, second.sourceGenerationId, EVIDENCE_FILE),
    );
    assert.equal(
      await generationFile(firstDataDir, first.sourceGenerationId, SOURCE_MANIFEST_FILE),
      await generationFile(secondDataDir, second.sourceGenerationId, SOURCE_MANIFEST_FILE),
    );
    assert.doesNotMatch(JSON.stringify(first), /checkout-a/);
    assert.doesNotMatch(JSON.stringify(second), /checkout-b/);
  });

  it("저장소 하나가 실패하면 기존 generation과 current pointer를 유지한다", async () => {
    const gitRoot = await temporaryDirectory("memory-atomic-git-");
    await createGitFixture(gitRoot);
    const dataDir = await temporaryDirectory("memory-atomic-data-");
    await writeDoorayFixture(dataDir);
    await normalizeEvidence({ project: "tc-ocr", gitRoot, dataDir });
    const projectDirectory = path.join(dataDir, "memory", "tc-ocr");
    const pointerBefore = await readFile(path.join(projectDirectory, CURRENT_SOURCE_POINTER_FILE), "utf8");
    const generationsBefore = await readdir(path.join(projectDirectory, SOURCE_GENERATIONS_DIRECTORY));

    const broken = path.join(gitRoot, "Broken.API");
    await mkdir(broken);
    git(broken, ["init", "-b", "main"]);
    await assert.rejects(() => normalizeEvidence({ project: "tc-ocr", gitRoot, dataDir }), /Git repository Broken\.API/);

    assert.equal(await readFile(path.join(projectDirectory, CURRENT_SOURCE_POINTER_FILE), "utf8"), pointerBefore);
    assert.deepEqual(await readdir(path.join(projectDirectory, SOURCE_GENERATIONS_DIRECTORY)), generationsBefore);
  });
});
