import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  CORE_CONCEPTS,
  ConceptDictionarySchema,
  INFERRED_GRAPH_FILE,
  PARSED_GRAPH_FILE,
  type ConceptDictionary,
  type OntologyRelationship,
} from "@devloop/shared";
import { buildEndpointIndex, readDroppedRelationships } from "../infer/llm-relationship-sanitizer";
import { compareCodePoints } from "./node-merge";
import type { ResolveInput } from "./resolve";
import { ResolveReportFileSchema, type ResolveReportFile, type ResolveResult, type SourcedRecord } from "./resolve.schema";
import type { GraphRecord } from "../parse/graph-record";

/**
 * `graph/<project>/` 의 파일명을 명시해 읽는다 — 디렉터리를 훑지 않는다.
 * 훑으면 같은 디렉터리에 생긴 `resolved.jsonl` 까지 입력으로 딸려 들어가,
 * `conceptSource`(`parsed.jsonl`·`inferred.jsonl` 만 허용)가 이를 알 수 없는 파일로 보고 예외를 던진다.
 */
async function readJsonlFile(filePath: string): Promise<SourcedRecord[]> {
  const content = await readFile(filePath, "utf8");
  const sourceFile = basename(filePath);
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { value: JSON.parse(line), sourceFile };
      } catch (error) {
        throw new Error(`${filePath}:${index + 1} invalid JSONL record: ${(error as Error).message}`);
      }
    });
}

async function readRequiredJsonlFile(filePath: string): Promise<SourcedRecord[]> {
  try {
    return await readJsonlFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${filePath} 이 없습니다. parse-structure 를 먼저 실행하세요.`);
    }
    throw error;
  }
}

async function readOptionalJsonlFile(filePath: string): Promise<SourcedRecord[]> {
  try {
    return await readJsonlFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`${filePath} 이 없어 구조 노드만으로 진행합니다. infer-knowledge 를 아직 안 돌렸다면 정상입니다.`);
      return [];
    }
    throw error;
  }
}

async function loadConceptDictionary(dataDir: string, project: string): Promise<ConceptDictionary> {
  const path = resolve(dataDir, "concepts", `${project}.json`);
  try {
    const raw = await readFile(path, "utf8");
    return ConceptDictionarySchema.parse([...CORE_CONCEPTS, ...JSON.parse(raw)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ConceptDictionarySchema.parse(CORE_CONCEPTS);
    }
    throw error;
  }
}

/**
 * `ResolveInput` 의 다섯 입력을 모두 읽는다. 호출처는 `resolve-graph`·`sync-neo4j` 둘이다.
 *
 * raw 문서(`endpointIndex` 재료)가 없어도 여기서는 예외를 던지지 않는다 — 기존 `sync-neo4j` 동작
 * 그대로다. 색인이 비면 `resolveGraph` 가 관계를 전부 drop 하므로 결과가 "빈 그래프"가 되지만,
 * 그 판단(실패시킬지 말지)은 명령마다 다르다. `resolve-graph` 는 dry-run 비교가 존재 이유라
 * 빈 색인이 조용히 "차이 없음"으로 보이면 안 되므로 `resolve/cli.ts` 가 별도로 검사해 실패시킨다.
 * `sync-neo4j` 는 여기서 검사하지 않으며 적재 동작이 바뀌지 않는다.
 */
export async function readResolveInput(dataDir: string, project: string): Promise<ResolveInput> {
  const graphDir = resolve(dataDir, "graph", project);
  const parsed = await readRequiredJsonlFile(resolve(graphDir, PARSED_GRAPH_FILE));
  const inferred = await readOptionalJsonlFile(resolve(graphDir, INFERRED_GRAPH_FILE));
  const dictionary = await loadConceptDictionary(dataDir, project);
  const endpointIndex = await buildEndpointIndex(dataDir, project);
  const previousDropped = await readDroppedRelationships(resolve(graphDir, "inference-dropped-relationships.json"));

  return { parsed, inferred, dictionary, endpointIndex, previousDropped };
}

/**
 * `type·startKey·endKey` 만으로는 전순서가 안 나온다 — 식별 속성(예: `ASSIGNED_TO.role`,
 * `TAGGED.dimension`)으로만 갈리는 관계는 세 키가 모두 같아 남은 순서가 정해지지 않는다.
 * 지금은 V8 의 안정 정렬 덕에 입력 순서가 우연히 유지될 뿐이라, 입력 순서가 바뀌면
 * (예: 파일 병합 순서 변경) 바이트 동등이 조용히 깨질 수 있다.
 *
 * 어떤 속성이 식별에 쓰이는지는 `resolve/` 가 알 필요 없다 — 그건 Neo4j 적재기(`neo4j/sync.const.ts`
 * 의 `RELATIONSHIP_IDENTITY_PROPERTIES`)의 쓰기 관심사다. `resolve/` 는 결정성만 보장하면 되므로,
 * 정렬된 properties 전체를 tie-break 키로 쓴다 — 어떤 속성이 갈랐든 전순서가 선다.
 */
function relationshipTieBreakKey(relationship: OntologyRelationship): string {
  const sortedEntries = Object.keys(relationship.properties)
    .sort(compareCodePoints)
    .map((key) => [key, relationship.properties[key]]);
  return JSON.stringify(sortedEntries);
}

/**
 * 노드는 라벨 → 키, 관계는 유형 → 시작키 → 끝키 → tie-break 순으로 정렬해 바이트 동등을 보장한다.
 * `resolveGraph` 는 순수 함수로 남기고(Map 순회 순서에 좌우됨), 결정적 순서는 파일로 쓸 때만 강제한다.
 */
function sortedGraphRecords(result: ResolveResult): GraphRecord[] {
  const nodes = [...result.nodes].sort((a, b) => compareCodePoints(a.label, b.label) || compareCodePoints(a.key, b.key));
  const relationships = [...result.relationships].sort(
    (a, b) =>
      compareCodePoints(a.type, b.type) ||
      compareCodePoints(a.startKey, b.startKey) ||
      compareCodePoints(a.endKey, b.endKey) ||
      compareCodePoints(relationshipTieBreakKey(a), relationshipTieBreakKey(b)),
  );
  return [...nodes, ...relationships];
}

/**
 * `resolved.jsonl` 을 쓴다. `parsed.jsonl`·`inferred.jsonl` 과 같은 형식(노드 또는 관계 하나씩,
 * 한 줄에 하나)이다 — 메타데이터 줄을 첫 줄에 넣지 않는다. 읽는 쪽이 그 규칙을 잊으면 조용히 깨진다.
 */
export async function writeResolved(outPath: string, result: ResolveResult): Promise<void> {
  const records = sortedGraphRecords(result);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "", "utf8");
}

export async function writeResolveReport(outPath: string, result: ResolveResult): Promise<void> {
  const report: ResolveReportFile = ResolveReportFileSchema.parse({
    nodeCount: result.nodes.length,
    relationshipCount: result.relationships.length,
    unknownConcepts: [...result.unknownConcepts.entries()].sort(([left], [right]) => compareCodePoints(left, right)),
    skippedRelationships: result.skippedRelationships,
    droppedRelationships: result.droppedRelationships,
    rewrittenRelationships: result.rewrittenRelationships,
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
