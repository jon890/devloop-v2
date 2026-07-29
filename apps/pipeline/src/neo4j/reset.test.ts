import assert from "node:assert/strict";
import test from "node:test";
import { assertForce, assertNotProductionUri, parseResetArgs, PRODUCTION_BOLT_PORT } from "./reset";

test("--force 없이 호출하면 거부한다", () => {
  const options = parseResetArgs([]);
  assert.equal(options.force, false);
  assert.throws(() => assertForce(options), /--force/);
});

test("--force 를 지정하면 통과한다", () => {
  const options = parseResetArgs(["--force"]);
  assert.equal(options.force, true);
  assert.doesNotThrow(() => assertForce(options));
});

test("운영 포트(7687)를 명시하면 거부한다", () => {
  assert.throws(() => assertNotProductionUri("bolt://localhost:7687"), /운영 포트/);
});

test("포트를 생략한 URI 도 운영으로 간주해 거부한다 — bolt 기본 포트가 7687 이기 때문이다", () => {
  assert.throws(() => assertNotProductionUri("bolt://localhost"), /운영 포트/);
});

test("테스트 포트(7690)는 통과한다", () => {
  assert.doesNotThrow(() => assertNotProductionUri("bolt://localhost:7690"));
});

test("PRODUCTION_BOLT_PORT 상수는 7687 이다", () => {
  assert.equal(PRODUCTION_BOLT_PORT, "7687");
});
