import neo4j, { type Driver } from "neo4j-driver";
import { DEFAULT_PROJECT, readFlag } from "../cli-options";
import { neo4jCredentials } from "./neo4j-config";

/** 운영 개발 DB 포트. `test/helpers/e2e-env.js` 의 `PRODUCTION_BOLT_PORT` 와 같은 값이다. */
export const PRODUCTION_BOLT_PORT = "7687";

interface ResetOptions {
  /** 출력 표기용으로만 쓴다 — 삭제 범위는 항상 전체다 (Task.number 가 프로젝트를 구분하지 않는다). */
  project: string;
  force: boolean;
  /** 운영 포트(7687)를 대상으로 허용할지. `--force` 와 별개 플래그로 둬 "삭제 의도"와 "운영 대상 의도"를 분리한다. */
  allowProduction: boolean;
}

export function parseResetArgs(args: readonly string[]): ResetOptions {
  const project = readFlag(args, "--project") ?? DEFAULT_PROJECT;
  const force = args.includes("--force");
  const allowProduction = args.includes("--allow-production");
  return { project, force, allowProduction };
}

/**
 * `NEO4J_URI` 가 반드시 지정돼 있어야 한다 — 기본값(`bolt://localhost:7687`)을 두지 않는다.
 * 기본값을 두면 대상을 명시하지 않고 실행한 것이 우연히 운영 포트를 가리키게 되고, 이 저장소는
 * 그 우연한 일치로 이미 한 번 데었다("환경변수 부재가 조용히 다른 모델로 돌게 만들었다", CLAUDE.md).
 * 삭제 명령에서는 그 우연이 데이터 손실로 이어지므로 대상을 항상 명시하게 만든다.
 */
export function assertNeo4jUriProvided(uri: string | undefined): asserts uri is string {
  if (!uri) {
    throw new Error("reset-neo4j 는 NEO4J_URI 환경변수가 있어야 실행됩니다. 삭제 대상을 항상 명시적으로 지정하세요.");
  }
}

/**
 * 운영 개발 DB 포트를 가리키는 URI 는 `--allow-production` 없이 거부한다. 포트가 없으면 bolt
 * 기본값 7687 로 본다 — `bolt://localhost` 처럼 포트를 생략한 URI 도 운영으로 간주해야 빠져나가지 않는다.
 * 7687 은 이 저장소의 로컬 Docker 컨테이너지만, `apply-schema`·`sync-neo4j` 가 그 포트를 기본값으로
 * 쓰는 유일한 "운영 그래프"이므로 파괴적 명령인 reset 은 별도 플래그로 명시적 동의를 받는다.
 *
 * 판정은 **포트만** 본다 — 호스트는 보지 않는다. 그래서 `bolt://prod-host:7690` 처럼 호스트가
 * 명백히 운영이어도 포트가 7687 이 아니면 `--allow-production` 없이 통과한다. 의도한 설계다.
 * 이 저장소의 "운영"이 곧 로컬 7687 컨테이너이기 때문이고, 원격 호스트까지 판정하려면 호스트
 * 목록을 별도로 관리해야 해 지금 범위를 넘는다.
 */
export function assertProductionAllowed(uri: string, allowProduction: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`NEO4J_URI 형식이 올바르지 않습니다(스킴 누락 등): ${uri}. 예: bolt://localhost:7690`);
  }
  const port = parsed.port || PRODUCTION_BOLT_PORT;
  if (port === PRODUCTION_BOLT_PORT && !allowProduction) {
    throw new Error(`reset-neo4j 는 운영 포트(${PRODUCTION_BOLT_PORT})를 --allow-production 없이 대상으로 실행할 수 없습니다: ${uri}`);
  }
}

export function assertForce(options: ResetOptions): void {
  if (!options.force) {
    throw new Error("reset-neo4j 는 --force 없이 실행할 수 없습니다. 전체 그래프를 삭제하는 명령입니다.");
  }
}

async function countGraph(driver: Driver): Promise<{ nodes: number; relationships: number }> {
  const session = driver.session({ database: "neo4j" });
  try {
    const nodeResult = await session.run("MATCH (n) RETURN count(n) AS count");
    const relationshipResult = await session.run("MATCH ()-[r]->() RETURN count(r) AS count");
    return {
      nodes: nodeResult.records[0].get("count").toNumber(),
      relationships: relationshipResult.records[0].get("count").toNumber(),
    };
  } finally {
    await session.close();
  }
}

export async function resetNeo4j(options: ResetOptions): Promise<void> {
  assertForce(options);

  const uri = process.env.NEO4J_URI;
  assertNeo4jUriProvided(uri);
  assertProductionAllowed(uri, options.allowProduction);

  const { user, password } = neo4jCredentials();
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  try {
    const before = await countGraph(driver);
    console.log(JSON.stringify({ uri, scope: "ALL_PROJECTS", requestedBy: options.project, before }, null, 2));

    const session = driver.session({ database: "neo4j" });
    try {
      await session.run("MATCH (n) DETACH DELETE n");
    } finally {
      await session.close();
    }

    const after = await countGraph(driver);
    console.log(JSON.stringify({ uri, scope: "ALL_PROJECTS", requestedBy: options.project, after }, null, 2));
    if (after.nodes !== 0) {
      throw new Error(`삭제 후에도 노드 ${after.nodes}개가 남아 있습니다.`);
    }
  } finally {
    await driver.close();
  }
}

if (require.main === module) {
  void resetNeo4j(parseResetArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
