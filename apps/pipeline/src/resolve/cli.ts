import "reflect-metadata";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { RESOLVED_GRAPH_FILE } from "@devloop/shared";
import { DEFAULT_PROJECT, readDataDirFlag, readFlag } from "../cli-options";
import { type PipelineConfig, withPipelineConfig } from "../config";
import { readResolveInput, writeResolved, writeResolveReport } from "./io";
import { compareCodePoints } from "./node-merge";
import { resolveGraph, type ResolveInput } from "./resolve";

interface ResolveCliOptions {
  project: string;
  dataDir: string;
  outPath: string;
  reportPath: string;
}

/**
 * `--data-dir`·`PIPELINE_DATA_DIR` 은 절대 경로만 받는다(우선순위는 `readDataDirFlag` 참조).
 * 상대 경로는 실행 시점의 cwd 기준으로 풀리므로, 저장소 루트가 아닌 곳에서 실행하거나
 * `resolve-graph` 와 `sync-neo4j` 를 서로 다른 cwd 에서 실행하면 같은 상대 경로가 다른
 * 디렉터리를 가리킬 수 있다 — CLAUDE.md 에 기록된 실제 함정이다.
 *
 * `sync-neo4j` 의 `PIPELINE_DATA_DIR` 는 상대 경로도 받아 cwd 기준으로 조용히 푼다(neo4j/sync.ts).
 * 여기서는 그와 달리 환경변수도 절대 경로를 요구한다 — dry-run 비교가 이 단계의 존재 이유라,
 * 실행할 때마다 cwd 가 달라져 같은 환경변수가 다른 디렉터리로 풀리면 비교 결과를 신뢰할 수 없다.
 * 조용히 다르게 해석하기보다 즉시 실패시켜 함정을 반복하지 않게 한다.
 */
function resolveDataDir(dataDirFlag: string | undefined): string {
  if (dataDirFlag === undefined) {
    return resolve(__dirname, "../../data");
  }
  if (!isAbsolute(dataDirFlag)) {
    throw new Error(`--data-dir 또는 PIPELINE_DATA_DIR 은 절대 경로여야 합니다: ${dataDirFlag}`);
  }
  return resolve(dataDirFlag);
}

const DEFAULT_REPORT_FILE = "resolve-report.json";

/**
 * 리포트 경로를 `--out` 의 basename 에서 따 온다. dry-run 비교(ADR 이 예시로 든 흐름)가
 * `--out /tmp/before.jsonl` → `--out /tmp/after.jsonl` 처럼 같은 디렉터리에 서로 다른 이름으로
 * 두 번 실행하는 것이 전제인데, 리포트 이름을 고정하면 두 번째 실행이 첫 번째 리포트를 덮어써
 * before 값을 잃는다.
 *
 * 기본 산출물 이름(`resolved.jsonl`)만은 예외로 기존 이름 `resolve-report.json` 을 유지한다 —
 * `resolved.resolve-report.json` 으로 바꾸면 기본 실행(`--out` 생략)에서 익숙한 파일명이 바뀌어
 * 기존 스크립트·문서의 경로 참조가 깨진다.
 */
function reportPathFor(outPath: string): string {
  const dir = dirname(outPath);
  const base = basename(outPath);
  if (base === RESOLVED_GRAPH_FILE) {
    return resolve(dir, DEFAULT_REPORT_FILE);
  }
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base.replace(/\.[^./]+$/, "");
  return resolve(dir, `${stem}.resolve-report.json`);
}

export function parseResolveArgs(args: readonly string[], config: Pick<PipelineConfig, "pipelineDataDir">): ResolveCliOptions {
  const project = readFlag(args, "--project") ?? DEFAULT_PROJECT;
  const dataDir = resolveDataDir(readDataDirFlag(args, config));
  // `--out` 은 상대 경로를 허용한다 — `--data-dir` 과 달리 두 실행 간 비교 안정성이 걸려 있지 않다.
  // dry-run 비교는 두 `--out` 산출물을 직접 `cmp` 하므로, 상대 경로가 매 실행 cwd 기준으로 풀려도
  // 같은 cwd 에서 두 번 실행하는 한 결과가 어긋나지 않는다. 빠뜨린 것이 아니라 의도적인 비대칭이다.
  const outPath = resolve(readFlag(args, "--out") ?? resolve(dataDir, "graph", project, RESOLVED_GRAPH_FILE));
  const reportPath = reportPathFor(outPath);

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

export async function runResolveGraph(args: readonly string[], config: PipelineConfig): Promise<void> {
  const options = parseResolveArgs(args, config);
  const input = await readResolveInput(options.dataDir, options.project, config);
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
        // 객체가 아니라 튜플 배열로 낸다 — 객체는 숫자처럼 보이는 키(예: "483")를 정렬과 무관하게
        // 앞으로 재배치해서 비교자를 바꿔도 순서를 지킬 수 없다.
        // 파일(resolve-report.json)이 같은 이유로 튜플 배열을 쓴다
        // (resolve.schema.ts 의 UnknownConceptEntrySchema 주석 참조).
        unknownConcepts: [...result.unknownConcepts.entries()].sort(([left], [right]) => compareCodePoints(left, right)),
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
  void withPipelineConfig((config) => runResolveGraph(process.argv.slice(2), config)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
