import { dirname, isAbsolute, resolve } from "node:path";
import { RESOLVED_GRAPH_FILE } from "@devloop/shared";
import { DEFAULT_PROJECT, readFlag } from "../cli-options";
import { readResolveInput, writeResolved, writeResolveReport } from "./io";
import { resolveGraph, type ResolveInput } from "./resolve";

interface ResolveCliOptions {
  project: string;
  dataDir: string;
  outPath: string;
  reportPath: string;
}

/**
 * `--data-dir` 은 절대 경로만 받는다. 상대 경로는 pipeline 패키지(`__dirname`) 기준으로 풀리므로
 * 저장소 루트에서 실행하는 사용자가 기대하는 경로와 어긋난다 — CLAUDE.md 에 기록된 실제 함정이다.
 * 조용히 다르게 해석하기보다 즉시 실패시켜 함정을 반복하지 않게 한다.
 */
function resolveDataDir(dataDirFlag: string | undefined): string {
  if (dataDirFlag === undefined) {
    return resolve(__dirname, "../../data");
  }
  if (!isAbsolute(dataDirFlag)) {
    throw new Error(`--data-dir 은 절대 경로여야 합니다: ${dataDirFlag}`);
  }
  return resolve(dataDirFlag);
}

export function parseResolveArgs(args: readonly string[]): ResolveCliOptions {
  const project = readFlag(args, "--project") ?? DEFAULT_PROJECT;
  const dataDir = resolveDataDir(readFlag(args, "--data-dir"));
  const outPath = resolve(readFlag(args, "--out") ?? resolve(dataDir, "graph", project, RESOLVED_GRAPH_FILE));
  const reportPath = resolve(dirname(outPath), "resolve-report.json");

  return { project, dataDir, outPath, reportPath };
}

/**
 * 색인이 완전히 비면 `normalizeEndpoint` 가 Task·Wiki 끝점을 전부 drop 해 관계가 통째로 사라진
 * `resolved.jsonl` 이 정상 산출물처럼 나온다. 그러면 사전 변경 전후를 `cmp` 했을 때 둘 다 똑같이
 * 비어 "차이 없음"이라는 틀린 결론이 나온다 — 이 단계의 존재 이유가 정확히 그 비교이므로 실패시킨다.
 * `sync-neo4j` 는 이 검사를 하지 않는다(io.ts 의 문서 참조).
 */
export function assertEndpointIndexNotEmpty(input: ResolveInput): void {
  if (input.endpointIndex.taskNumbers.size === 0 && input.endpointIndex.wikiPageIds.size === 0) {
    throw new Error(
      "raw 문서(Task·Wiki)를 찾을 수 없습니다. data/raw/<project>/ 가 비어 있으면 관계가 전부 drop 됩니다 — fetch-dooray 를 먼저 실행하세요.",
    );
  }
}

export async function runResolveGraph(args: readonly string[]): Promise<void> {
  const options = parseResolveArgs(args);
  const input = await readResolveInput(options.dataDir, options.project);
  assertEndpointIndexNotEmpty(input);

  const result = resolveGraph(input);
  await writeResolved(options.outPath, result);
  await writeResolveReport(options.reportPath, result);

  console.log(
    JSON.stringify(
      {
        project: options.project,
        dataDir: options.dataDir,
        out: options.outPath,
        report: options.reportPath,
        nodes: result.nodes.length,
        relationships: result.relationships.length,
        unknownConcepts: Object.fromEntries([...result.unknownConcepts.entries()].sort()),
        skippedRelationships: result.skippedRelationships,
        droppedRelationships: result.droppedRelationships,
        rewrittenRelationships: result.rewrittenRelationships,
        endpointIndex: {
          taskEndpoints: input.endpointIndex.taskNumbers.size,
          wikiEndpoints: input.endpointIndex.wikiPageIds.size,
        },
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  void runResolveGraph(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
