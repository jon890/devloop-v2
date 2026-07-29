import neo4j, { type Driver } from "neo4j-driver";
import { DEFAULT_PROJECT, readFlag } from "../cli-options";
import { neo4jCredentials } from "./neo4j-config";

/** 운영 개발 DB 포트. `test/helpers/e2e-env.js` 의 `PRODUCTION_BOLT_PORT` 와 같은 값이다. */
export const PRODUCTION_BOLT_PORT = "7687";

interface ResetOptions {
  /** 출력 표기용으로만 쓴다 — 삭제 범위는 항상 전체다 (Task.number 가 프로젝트를 구분하지 않는다). */
  project: string;
  force: boolean;
}

export function parseResetArgs(args: readonly string[]): ResetOptions {
  const project = readFlag(args, "--project") ?? DEFAULT_PROJECT;
  const force = args.includes("--force");
  return { project, force };
}

/**
 * 운영 개발 DB 포트를 가리키는 URI 를 거부한다. 포트가 없으면 bolt 기본값 7687 로 본다.
 * `bolt://localhost` 처럼 포트를 생략한 URI 도 운영으로 간주해야 이 경우가 빠져나가지 않는다.
 */
export function assertNotProductionUri(uri: string): void {
  const port = new URL(uri).port || PRODUCTION_BOLT_PORT;
  if (port === PRODUCTION_BOLT_PORT) {
    throw new Error(`reset-neo4j 는 운영 포트(${PRODUCTION_BOLT_PORT})를 대상으로 실행할 수 없습니다: ${uri}`);
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

  const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
  assertNotProductionUri(uri);

  const { user, password } = neo4jCredentials();
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  try {
    const before = await countGraph(driver);
    console.log(JSON.stringify({ uri, project: options.project, before }, null, 2));

    const session = driver.session({ database: "neo4j" });
    try {
      await session.run("MATCH (n) DETACH DELETE n");
    } finally {
      await session.close();
    }

    const after = await countGraph(driver);
    console.log(JSON.stringify({ uri, project: options.project, after }, null, 2));
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
