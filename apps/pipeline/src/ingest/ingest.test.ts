import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DoorayExecutor } from "./dooray-executor";
import { IngestService } from "./ingest.service";

type FixtureHandler = (attempt: number) => unknown | Promise<unknown>;

class FixtureExecutor implements DoorayExecutor {
  readonly calls: string[] = [];
  readonly attempts = new Map<string, number>();
  maxActive = 0;
  private active = 0;

  constructor(private readonly fixtures: Map<string, FixtureHandler>) {}

  async execute(args: readonly string[]): Promise<string> {
    const command = args.join(" ");
    const attempt = (this.attempts.get(command) ?? 0) + 1;
    this.attempts.set(command, attempt);
    this.calls.push(command);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const fixture = this.fixtures.get(command);
      if (!fixture) {
        throw new Error(`fixture 없음: ${command}`);
      }
      return JSON.stringify(await fixture(attempt));
    } finally {
      this.active -= 1;
    }
  }
}

test("원본 계약대로 순차 수집하고 일시 실패를 3회 재시도한다", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "pipeline-ingest-"));
  const fixtures = new Map<string, FixtureHandler>([
    [
      "post list sample --all --json",
      async () => [
        { number: 1, users: { from: { member: { organizationMemberId: "m1" } } } },
        { number: 2, users: { to: [{ member: { organizationMemberId: "m2" } }] } },
      ],
    ],
    ["post get sample 1 --json", async () => ({ id: "p1", number: 1 })],
    ["post comment list sample 1 --json", async () => []],
    [
      "post get sample 2 --json",
      async (attempt) => {
        if (attempt <= 3) {
          throw new Error("temporary");
        }
        return { id: "p2", number: 2 };
      },
    ],
    ["post comment list sample 2 --json", async () => [{ id: "c2", creator: { organizationMemberId: "m2" } }]],
    ["wiki pages sample --json", async () => [{ id: "w1", root: true }]],
    ["wiki page get sample w1 --json", async () => ({ id: "w1", creator: { member: { organizationMemberId: "m1" } } })],
    ["wiki pages sample --parent w1 --json", async () => [{ id: "w2" }]],
    ["wiki page get sample w2 --json", async () => ({ id: "w2", creator: { member: { organizationMemberId: "m2" } } })],
    ["project tags sample --json", async () => [{ id: "t1", name: "0: Dev" }]],
    ["member list sample --json", async () => [{ id: "m1", name: "첫째" }]],
    ["member get m2 --json", async () => ({ id: "m2", name: "둘째" })],
  ]);
  const executor = new FixtureExecutor(fixtures);

  try {
    const result = await new IngestService(executor).ingest({
      project: "sample",
      limit: 2,
      dataRoot,
      retryDelaysMs: [0, 0, 0],
    });

    assert.deepEqual(result, {
      stats: { posts: 2, wiki: 2, tags: 1, members: 1 },
      failures: [],
    });
    assert.equal(executor.attempts.get("post get sample 2 --json"), 4);
    assert.equal(executor.maxActive, 1);

    const projectRoot = join(dataRoot, "sample");
    assert.deepEqual(await readJson(join(projectRoot, "posts.json")), [
      { number: 1, users: { from: { member: { organizationMemberId: "m1" } } } },
      { number: 2, users: { to: [{ member: { organizationMemberId: "m2" } }] } },
    ]);
    assert.deepEqual(await readJson(join(projectRoot, "posts", "2.json")), {
      post: { id: "p2", number: 2 },
      comments: [{ id: "c2", creator: { organizationMemberId: "m2" } }],
    });
    assert.deepEqual(await readJson(join(projectRoot, "tags.json")), { t1: "0: Dev" });
    assert.deepEqual(await readJson(join(projectRoot, "members.json")), {
      m1: "첫째",
      m2: "둘째",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("이미 저장된 파일은 다시 요청하지 않고 재개한다", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "pipeline-ingest-resume-"));
  const projectRoot = join(dataRoot, "sample");
  await mkdir(join(projectRoot, "posts"), { recursive: true });
  await mkdir(join(projectRoot, "wiki"), { recursive: true });
  await writeJson(join(projectRoot, "posts.json"), [{ number: 1 }]);
  await writeJson(join(projectRoot, "posts", "1.json"), {
    post: { id: "p1", number: 1 },
    comments: [],
  });
  await writeJson(join(projectRoot, "wiki", "w1.json"), { id: "w1" });
  await writeJson(join(projectRoot, "tags.json"), { t1: "0: Dev" });
  await writeJson(join(projectRoot, "members.json"), { m1: "첫째" });

  const executor = new FixtureExecutor(new Map([["wiki pages sample --json", async () => [{ id: "w1", root: true }]]]));

  try {
    const result = await new IngestService(executor).ingest({
      project: "sample",
      limit: 1,
      dataRoot,
      retryDelaysMs: [0, 0, 0],
    });

    assert.deepEqual(result.stats, { posts: 1, wiki: 1, tags: 1, members: 1 });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(executor.calls, ["wiki pages sample --json"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("3회 재시도 후에도 실패하면 실패 목록에 남긴다", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "pipeline-ingest-failure-"));
  const fixtures = new Map<string, FixtureHandler>([
    ["post list sample --all --json", async () => [{ number: 1 }]],
    ["post get sample 1 --json", async () => ({ id: "p1", number: 1 })],
    ["post comment list sample 1 --json", async () => Promise.reject(new Error("unavailable"))],
    ["wiki pages sample --json", async () => []],
    ["project tags sample --json", async () => []],
    ["member list sample --json", async () => []],
  ]);
  const executor = new FixtureExecutor(fixtures);

  try {
    const result = await new IngestService(executor).ingest({
      project: "sample",
      limit: 1,
      dataRoot,
      retryDelaysMs: [0, 0, 0],
    });

    assert.equal(executor.attempts.get("post comment list sample 1 --json"), 4);
    assert.equal(result.stats.posts, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.item, "post:1");
    assert.match(result.failures[0]?.command ?? "", /post comment list sample 1/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
