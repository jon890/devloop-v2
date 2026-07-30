import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRegistryDb,
  createRegistryPool,
  CurationSchema,
  migrateRegistryDb,
  MissingProjectError,
  readCuration,
  registerProject,
  replaceCuration,
  selectProjectByCode,
  upsertCuration,
  type Curation,
} from "@devloop/registry";
import { parseExportCurationArgs } from "./export-curation";
import { parseImportCurationArgs } from "./import-curation";
import { parseRegisterProjectArgs } from "./register-project";

test("register-project 는 source kind/key 를 함께 받거나 함께 거부한다", () => {
  assert.deepEqual(parseRegisterProjectArgs(["--code", "tc-ocr", "--name", "TC OCR", "--source-kind", "dooray", "--source-key", "tc-ocr"]), {
    code: "tc-ocr",
    name: "TC OCR",
    sourceKind: "dooray",
    sourceKey: "tc-ocr",
  });
  assert.throws(() => parseRegisterProjectArgs(["--code", "tc-ocr", "--name", "TC OCR", "--source-kind", "dooray"]), /함께 지정/);
  assert.throws(() => parseRegisterProjectArgs(["--code", "tc-ocr", "--name", "TC OCR", "--source-key", "tc-ocr"]), /함께 지정/);
  assert.throws(
    () => parseRegisterProjectArgs(["--code", "tc-ocr", "--name", "TC OCR", "--source-kind", "jira", "--source-key", "tc-ocr"]),
    /dooray 또는 github/,
  );
});

test("import/export curation 은 파일 경로를 절대 경로로만 받는다", () => {
  assert.throws(() => parseImportCurationArgs(["--project", "tc-ocr", "--file", "curation.json"]), /--file 은 절대 경로/);
  assert.throws(() => parseExportCurationArgs(["--project", "tc-ocr", "--out", "curation.json"]), /--out 은 절대 경로/);

  assert.equal(parseImportCurationArgs(["--project", "tc-ocr", "--file", "/tmp/curation.json", "--replace", "--dry-run"]).file, "/tmp/curation.json");
  assert.equal(parseExportCurationArgs(["--project", "tc-ocr", "--out", "/tmp/curation.json"]).out, "/tmp/curation.json");
});

test("curation schema 는 reason 없는 판단을 거부하고 exportedAt 봉투를 허용하지 않는다", () => {
  assert.throws(
    () =>
      CurationSchema.parse({
        project: "tc-ocr",
        merges: [{ canonical: "OCR API Gateway", aliases: ["Gateway"] }],
        blocks: [],
      }),
    /reason/,
  );
  assert.throws(
    () =>
      CurationSchema.parse({
        project: "tc-ocr",
        merges: [],
        blocks: [],
        exportedAt: "2026-07-28",
      }),
    /exportedAt/,
  );
});

const databaseUrl = process.env.REGISTRY_DATABASE_URL;
const hasTestDatabase = databaseUrl?.includes("localhost:15435/") || databaseUrl?.includes("127.0.0.1:15435/");

test(
  "register-project 는 다른 프로젝트가 소유한 source 를 거부하고 프로젝트 생성을 롤백한다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("source-owner", async ({ db, code }) => {
      const otherCode = `${code}_other`;
      await assert.rejects(
        () => registerProject(db, { code: otherCode, name: otherCode, sourceKind: "dooray", sourceKey: code }),
        /already registered to another project/,
      );
      assert.equal(await selectProjectByCode(db, otherCode), undefined);
    });
  },
);

test(
  "curation service 는 중복 alias 를 행별 rejected 로 남기고 나머지를 적용한다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("dupe", async ({ db, code }) => {
      const result = await upsertCuration(db, code, {
        project: code,
        merges: [
          { canonical: "OCR API Gateway", aliases: ["Gateway", "api gateway"], reason: "첫 판단" },
          { canonical: "Other Gateway", aliases: ["API-Gateway"], reason: "충돌 판단" },
        ],
        blocks: [{ key: "Document.Console", reason: "별도 개체" }],
      });

      assert.deepEqual(result.applied, { merges: 2, blocks: 1 });
      assert.equal(result.rejected.length, 1);
      assert.match(result.rejected[0].reason, /two canonical values/);

      const exported = await readCuration(db, code);
      assert.deepEqual(exported.merges, [{ canonical: "OCR API Gateway", aliases: ["api gateway", "Gateway"], reason: "첫 판단" }]);
      assert.deepEqual(exported.blocks, [{ key: "Document.Console", reason: "별도 개체" }]);
    });
  },
);

test(
  "replaceCuration 은 삽입 실패 시 삭제를 롤백한다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("rollback", async ({ db, code }) => {
      await upsertCuration(db, code, {
        project: code,
        merges: [],
        blocks: [{ key: "gateway api", reason: "기존 차단" }],
      });

      await assert.rejects(
        () =>
          replaceCuration(db, code, {
            project: code,
            merges: [{ canonical: "OCR API Gateway", aliases: ["Gateway"], reason: "잘못된 승인일", approvedAt: "not-a-date" }],
            blocks: [],
          } as Curation),
        /date|invalid input syntax/i,
      );

      assert.deepEqual(await readCuration(db, code), {
        project: code,
        merges: [],
        blocks: [{ key: "gateway api", reason: "기존 차단" }],
      });
    });
  },
);

test(
  "없는 프로젝트 오류는 등록된 프로젝트 목록을 함께 담는다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("missing-list", async ({ db, code }) => {
      await assert.rejects(
        () => readCuration(db, `${code}-missing`),
        (error) => error instanceof MissingProjectError && error.registeredProjects.some((project) => project.code === code),
      );
    });
  },
);

test(
  "export/import/export curation 은 같은 DB 상태에서 바이트가 같다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("roundtrip", async ({ db, code }) => {
      const directory = await mkdtemp(join(tmpdir(), "devloop-curation-"));
      try {
        const firstPath = join(directory, "c1.json");
        const secondPath = join(directory, "c2.json");
        await upsertCuration(db, code, {
          project: code,
          merges: [
            { canonical: "OCR API Gateway", aliases: ["Gateway", "api gateway"], reason: "후보 조사", approvedAt: "2026-07-28" },
            { canonical: "NHN Cloud Log & Crash", aliases: ["Log & Crash"], reason: "서비스명 통합" },
          ],
          blocks: [
            { key: "cloud.toast.com", reason: "와일드카드와 구분" },
            { key: "/analysis", reason: "API 경로와 일반명 구분" },
          ],
        });

        await writeFile(firstPath, `${JSON.stringify(await readCuration(db, code), null, 2)}\n`, "utf8");
        await replaceCuration(db, code, CurationSchema.parse(JSON.parse(await readFile(firstPath, "utf8"))));
        await writeFile(secondPath, `${JSON.stringify(await readCuration(db, code), null, 2)}\n`, "utf8");

        assert.equal(await readFile(firstPath, "utf8"), await readFile(secondPath, "utf8"));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  "registry migration 은 check·FK·cascade 제약을 적용한다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("migration-constraints", async ({ db, pool, code }) => {
      const project = await selectProjectByCode(db, code);
      assert.ok(project);

      await assert.rejects(
        () =>
          pool.query("insert into concept_decision (project_id, key_raw, key_norm, kind, canonical, reason) values ($1, $2, $3, $4, $5, $6)", [
            project.id,
            "invalid-kind",
            "invalidkind",
            "unknown",
            null,
            "check constraint",
          ]),
        /concept_decision_kind_check/,
      );
      await assert.rejects(
        () =>
          pool.query("insert into concept_decision (project_id, key_raw, key_norm, kind, canonical, reason) values ($1, $2, $3, $4, $5, $6)", [
            project.id,
            "missing-canonical",
            "missingcanonical",
            "merge_alias",
            null,
            "check constraint",
          ]),
        /concept_decision_canonical_check/,
      );
      await assert.rejects(
        () => pool.query("insert into source (project_id, kind, external_key) values ($1, $2, $3)", [project.id, "jira", `${code}-jira`]),
        /source_kind_check/,
      );
      await assert.rejects(
        () =>
          pool.query("insert into concept_decision (project_id, key_raw, key_norm, kind, canonical, reason) values ($1, $2, $3, $4, $5, $6)", [
            2_147_483_647,
            "orphan",
            "orphan",
            "block",
            null,
            "foreign key",
          ]),
        /concept_decision_project_id_project_id_fk/,
      );

      await upsertCuration(db, code, {
        project: code,
        merges: [],
        blocks: [{ key: "gateway api", reason: "cascade 확인" }],
      });
      await pool.query("delete from project where id = $1", [project.id]);

      assert.equal((await pool.query("select count(*)::int as count from source where project_id = $1", [project.id])).rows[0].count, 0);
      assert.equal((await pool.query("select count(*)::int as count from concept_decision where project_id = $1", [project.id])).rows[0].count, 0);
    });
  },
);

test(
  "import-curation CLI 는 replace 삽입 실패를 롤백하고 종료 코드 1을 반환한다",
  { skip: hasTestDatabase ? false : "REGISTRY_DATABASE_URL on port 15435 is required" },
  async () => {
    await withTestRegistry("cli-rollback", async ({ db, code }) => {
      await upsertCuration(db, code, {
        project: code,
        merges: [],
        blocks: [{ key: "gateway api", reason: "기존 차단" }],
      });
      const directory = await mkdtemp(join(tmpdir(), "devloop-curation-cli-"));
      try {
        const inputPath = join(directory, "invalid-date.json");
        await writeFile(
          inputPath,
          `${JSON.stringify({
            project: code,
            merges: [
              {
                canonical: "OCR API Gateway",
                aliases: ["Gateway"],
                reason: "존재하지 않는 승인일",
                approvedAt: "2026-02-30",
              },
            ],
            blocks: [],
          })}\n`,
          "utf8",
        );

        const result = spawnSync(process.execPath, [join(__dirname, "import-curation.js"), "--project", code, "--file", inputPath, "--replace"], {
          encoding: "utf8",
          env: { ...process.env, REGISTRY_DATABASE_URL: databaseUrl },
          timeout: 30_000,
        });

        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.match(result.stderr, /date|time|range/i);
        assert.deepEqual(await readCuration(db, code), {
          project: code,
          merges: [],
          blocks: [{ key: "gateway api", reason: "기존 차단" }],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

async function withTestRegistry(
  name: string,
  run: (context: { db: ReturnType<typeof createRegistryDb>; pool: ReturnType<typeof createRegistryPool>; code: string }) => Promise<void>,
): Promise<void> {
  if (!databaseUrl) throw new Error("REGISTRY_DATABASE_URL is required.");
  const pool = createRegistryPool(databaseUrl);
  const db = createRegistryDb(pool);
  const code = `phase02_${name}_${process.pid}_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    await migrateRegistryDb(pool);
    await registerProject(db, { code, name: code, sourceKind: "dooray", sourceKey: code });
    await run({ db, pool, code });
  } finally {
    await pool.query("delete from project where code = $1", [code]);
    await pool.end();
  }
}
