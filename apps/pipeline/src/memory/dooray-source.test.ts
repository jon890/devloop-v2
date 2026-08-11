import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { normalizeDooraySource } from "./dooray-source";

const temporaryDirectories: string[] = [];

async function createRawFixture(
  options: { postBody?: string; postSubject?: string | null; commentBody?: string; wikiBody?: string; wikiSubject?: string | null } = {},
): Promise<{ dataDir: string; project: string }> {
  const { postBody = "업무 본문", postSubject = "업무 제목", commentBody = "댓글 본문", wikiBody = "위키 본문", wikiSubject = "위키 제목" } = options;
  const dataDir = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "memory-dooray-")));
  temporaryDirectories.push(dataDir);
  const project = "tc-ocr";
  const rawDirectory = path.join(dataDir, "raw", project);
  await mkdir(path.join(rawDirectory, "posts"), { recursive: true });
  await mkdir(path.join(rawDirectory, "wiki"), { recursive: true });
  await writeFile(
    path.join(rawDirectory, "posts", "101.json"),
    JSON.stringify({
      post: {
        id: "3935008503199859816",
        number: 101,
        ...(postSubject === null ? {} : { subject: postSubject }),
        body: { content: postBody },
      },
      comments: [{ id: "4053801154616695067", body: { content: commentBody } }],
    }),
  );
  await writeFile(
    path.join(rawDirectory, "wiki", "201.json"),
    JSON.stringify({ pageId: "201", ...(wikiSubject === null ? {} : { subject: wikiSubject }), body: { content: wikiBody } }),
  );
  return { dataDir, project };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Dooray source", () => {
  it("task, comment, Wiki에 실제 URL과 안정 ID를 연결한다", async () => {
    const fixture = await createRawFixture();
    const result = await normalizeDooraySource(fixture.dataDir, fixture.project);
    const refs = result.packets.flatMap((packet) => packet.sourceRefs);

    const task = refs.find((ref) => ref.sourceType === "dooray-task");
    const comment = refs.find((ref) => ref.sourceType === "dooray-comment");
    const wiki = refs.find((ref) => ref.sourceType === "dooray-wiki");
    assert.equal(task?.sourceId, "3935008503199859816");
    assert.equal(task?.url, "https://nhnent.dooray.com/project/tasks/3935008503199859816");
    assert.equal(comment?.sourceId, "4053801154616695067");
    assert.equal(comment?.parentId, task?.sourceId);
    assert.equal(comment?.url, task?.url);
    assert.equal(wiki?.url, "https://nhnent.dooray.com/project/pages/201");
    assert.deepEqual(result.counts, { tasks: 1, comments: 1, wikis: 1 });
  });

  it("task 본문이 없으면 title을 최소 evidence로 쓴다", async () => {
    const fixture = await createRawFixture({ postBody: "" });
    const result = await normalizeDooraySource(fixture.dataDir, fixture.project);
    assert.deepEqual(result.packets.find((packet) => packet.sourceKind === "dooray-task")?.segments, [
      { sourceRefKey: "dooray-task:3935008503199859816", text: "업무 제목" },
      { sourceRefKey: "dooray-comment:4053801154616695067", text: "댓글 본문" },
    ]);
  });

  it("task 본문과 실제 title이 모두 없으면 display fallback을 evidence로 쓰지 않고 실패한다", async () => {
    const fixture = await createRawFixture({ postBody: "", postSubject: null });
    await assert.rejects(() => normalizeDooraySource(fixture.dataDir, fixture.project), /Dooray task 원천 .*필수 본문 또는 title/);
  });

  it("wiki 본문이 없으면 title을 최소 evidence로 쓴다", async () => {
    const fixture = await createRawFixture({ wikiBody: "" });
    const result = await normalizeDooraySource(fixture.dataDir, fixture.project);
    assert.deepEqual(result.packets.find((packet) => packet.sourceKind === "dooray-wiki")?.segments, [
      { sourceRefKey: "dooray-wiki:201", text: "위키 제목" },
    ]);
  });

  it("wiki 본문과 실제 title이 모두 없으면 display fallback을 evidence로 쓰지 않고 실패한다", async () => {
    const fixture = await createRawFixture({ wikiBody: "", wikiSubject: null });
    await assert.rejects(() => normalizeDooraySource(fixture.dataDir, fixture.project), /Dooray wiki 원천 .*필수 본문 또는 title/);
  });

  it("comment 본문이 없으면 fallback 없이 실패한다", async () => {
    const fixture = await createRawFixture({ commentBody: "" });
    await assert.rejects(() => normalizeDooraySource(fixture.dataDir, fixture.project), /Dooray comment 원천 .*comments\[0\].*본문/);
  });
});
