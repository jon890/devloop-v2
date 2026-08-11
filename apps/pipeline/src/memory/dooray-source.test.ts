import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { normalizeDooraySource } from "./dooray-source";

const temporaryDirectories: string[] = [];

async function createRawFixture(postBody = "업무 본문"): Promise<{ dataDir: string; project: string }> {
  const dataDir = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "memory-dooray-")));
  temporaryDirectories.push(dataDir);
  const project = "tc-ocr";
  const rawDirectory = path.join(dataDir, "raw", project);
  await mkdir(path.join(rawDirectory, "posts"), { recursive: true });
  await mkdir(path.join(rawDirectory, "wiki"), { recursive: true });
  await writeFile(
    path.join(rawDirectory, "posts", "101.json"),
    JSON.stringify({
      post: { id: "3935008503199859816", number: 101, subject: "업무 제목", body: { content: postBody } },
      comments: [{ id: "4053801154616695067", body: { content: "댓글 본문" } }],
    }),
  );
  await writeFile(
    path.join(rawDirectory, "wiki", "201.json"),
    JSON.stringify({ pageId: "201", subject: "위키 제목", body: { content: "위키 본문" } }),
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

  it("필수 본문이 없으면 원천 종류와 위치를 포함해 실패한다", async () => {
    const fixture = await createRawFixture("");
    await assert.rejects(() => normalizeDooraySource(fixture.dataDir, fixture.project), /Dooray task 원천 .*posts.*본문/);
  });
});
