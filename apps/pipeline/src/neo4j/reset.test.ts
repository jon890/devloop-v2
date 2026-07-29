import assert from "node:assert/strict";
import test from "node:test";
import { assertForce, assertNeo4jUriProvided, assertProductionAllowed, parseResetArgs, PRODUCTION_BOLT_PORT, resetNeo4j } from "./reset";

/**
 * `resetNeo4j` 가 세 가드(`assertForce`·`assertNeo4jUriProvided`·`assertProductionAllowed`)를
 * 실제로 호출하는지 검증한다. 가드 함수 자체를 직접 부르는 단위 테스트만으로는 부족하다 —
 * `resetNeo4j` 본문에서 그 호출을 지워도 가드 함수 단위 테스트는 여전히 통과하기 때문이다
 * (실측: 이전 버전에서 두 가드 호출을 지워도 기존 테스트 6건 전부 통과했다).
 *
 * NEO4J_URI 를 존재하지 않는 호스트(`invalid.invalid`, RFC 2606 예약 TLD)로 돌려 둔다 — 가드가
 * 정상 동작할 때는 드라이버 생성 전에 던지므로 네트워크에 닿지 않지만, 가드 호출이 지워진 채로
 * 실행되더라도(변이 검증 중 포함) DNS 해석 실패로 즉시 끊겨 실제 Neo4j(7687, 운영 DB)에
 * 연결·삭제가 일어나지 않는다.
 */
function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  return run().finally(() => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  });
}

test("resetNeo4j 는 assertForce 를 호출한다 — force 없이 실행하면 DB 접속 전에 거부한다", async () => {
  await withEnv("NEO4J_URI", "bolt://invalid.invalid:7687", () =>
    assert.rejects(() => resetNeo4j({ project: "tc-ocr", force: false, allowProduction: false }), /--force/),
  );
});

test("resetNeo4j 는 assertNeo4jUriProvided 를 호출한다 — NEO4J_URI 가 없으면 DB 접속 전에 거부한다", async () => {
  await withEnv("NEO4J_URI", undefined, () =>
    assert.rejects(() => resetNeo4j({ project: "tc-ocr", force: true, allowProduction: true }), /NEO4J_URI/),
  );
});

test("resetNeo4j 는 assertProductionAllowed 를 호출한다 — 운영 포트면 --allow-production 없이 DB 접속 전에 거부한다", async () => {
  await withEnv("NEO4J_URI", "bolt://invalid.invalid:7687", () =>
    assert.rejects(() => resetNeo4j({ project: "tc-ocr", force: true, allowProduction: false }), /운영 포트/),
  );
});

test("resetNeo4j 는 --allow-production 이 있으면 운영 포트 가드를 통과해 드라이버 단계까지 간다", async () => {
  // 가드를 통과하면 다음 실패는 가드 에러(운영 포트·NEO4J_URI·--force)가 아니라
  // DNS 해석 실패(ENOTFOUND) 여야 한다 — 즉 이 실패가 "가드를 지나갔다"는 증거다.
  await withEnv("NEO4J_URI", "bolt://invalid.invalid:7687", () =>
    assert.rejects(
      () => resetNeo4j({ project: "tc-ocr", force: true, allowProduction: true }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /운영 포트|NEO4J_URI|--force/);
        return true;
      },
    ),
  );
});

test("resetNeo4j 는 운영 포트가 아니면 --allow-production 없이도 드라이버 단계까지 간다", async () => {
  await withEnv("NEO4J_URI", "bolt://invalid.invalid:7690", () =>
    assert.rejects(
      () => resetNeo4j({ project: "tc-ocr", force: true, allowProduction: false }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /운영 포트|NEO4J_URI|--force/);
        return true;
      },
    ),
  );
});

test("--force 없이 호출하면 거부한다", () => {
  const options = parseResetArgs([]);
  assert.equal(options.force, false);
  assert.equal(options.allowProduction, false);
  assert.throws(() => assertForce(options), /--force/);
});

test("--force 를 지정하면 통과한다", () => {
  const options = parseResetArgs(["--force"]);
  assert.equal(options.force, true);
  assert.doesNotThrow(() => assertForce(options));
});

test("--allow-production 을 지정하면 allowProduction 이 true 가 된다", () => {
  const options = parseResetArgs(["--force", "--allow-production"]);
  assert.equal(options.allowProduction, true);
});

test("NEO4J_URI 가 없으면 거부한다", () => {
  assert.throws(() => assertNeo4jUriProvided(undefined), /NEO4J_URI/);
});

test("NEO4J_URI 가 있으면 통과한다", () => {
  assert.doesNotThrow(() => assertNeo4jUriProvided("bolt://localhost:7690"));
});

test("운영 포트(7687) + --allow-production 없음은 거부한다", () => {
  assert.throws(() => assertProductionAllowed("bolt://localhost:7687", false), /운영 포트/);
});

test("운영 포트(7687) + --allow-production 있음은 통과한다", () => {
  assert.doesNotThrow(() => assertProductionAllowed("bolt://localhost:7687", true));
});

test("포트를 생략한 URI 도 운영으로 간주해 거부한다 — bolt 기본 포트가 7687 이기 때문이다", () => {
  assert.throws(() => assertProductionAllowed("bolt://localhost", false), /운영 포트/);
});

test("테스트 포트(7690)는 --allow-production 없이도 통과한다", () => {
  assert.doesNotThrow(() => assertProductionAllowed("bolt://localhost:7690", false));
});

test("PRODUCTION_BOLT_PORT 상수는 7687 이다", () => {
  assert.equal(PRODUCTION_BOLT_PORT, "7687");
});
