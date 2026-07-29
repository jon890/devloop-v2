export const DEFAULT_PROJECT = "tc-ocr";

export interface PipelineOptions {
  project: string;
  stage?: string;
  limit?: number;
  /** 지식 추론 부분 실행용 sourceDocId 목록 (--docs Task:483,Wiki:123) */
  docs?: string[];
}

export function parsePipelineOptions(args: readonly string[]): PipelineOptions {
  const project = optionValue(args, "--project");
  const limitValue = optionValue(args, "--limit");
  const docsValue = optionValue(args, "--docs");
  const optionValues = new Set([project, limitValue, docsValue].filter((value): value is string => !!value));
  const stage = args.find((arg) => !arg.startsWith("-") && !optionValues.has(arg));

  let limit: number | undefined;
  if (limitValue !== undefined) {
    limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("--limit 값은 1 이상의 정수여야 합니다.");
    }
  }

  const docs = docsValue
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (docsValue !== undefined && docs?.length === 0) {
    throw new Error("--docs 값에는 sourceDocId를 하나 이상 입력해야 합니다.");
  }

  return {
    project: project?.trim() || DEFAULT_PROJECT,
    stage,
    limit,
    ...(docs ? { docs } : {}),
  };
}

// optionValue 와 readFlag 는 둘 다 "플래그 뒤 값 하나 읽기"를 하고, 다음 인자가 플래그면
// 값이 없는 것으로 다루는 가드도 둘 다 갖는다. 차이는 값이 아예 없을 때의 동작이다.
// optionValue 는 예외를 던진다 — parsePipelineOptions 는 --limit·--docs 처럼 값이 있어야만
// 의미가 있는 옵션에 쓰므로, 값 없이 다음 플래그로 조용히 넘어가면 오입력을 놓친다.
// readFlag 는 undefined 를 돌려준다 — sync-neo4j·resolve-graph 의 --project·--data-dir·--out 은
// 전부 기본값이 있는 선택 옵션이라 값이 없으면 그냥 기본값을 쓰면 된다.
// 하나로 합치면 호출부마다 다시 예외 처리(try/catch 또는 ?? 대체)를 감싸야 해서 오히려 복잡해진다.
function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} 값을 입력해야 합니다.`);
  }
  return value;
}

// 다음 인자가 `-`로 시작하면(다른 플래그) 값이 아니라 값 없음으로 다룬다.
// 이 가드가 없으면 `resolve-graph --out --project tc-ocr` 같은 입력에서
// `--out` 의 값이 `"--project"` 라는 문자열로 잘못 채워진다.
export function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value?.startsWith("-")) {
    return undefined;
  }
  return value?.trim() || undefined;
}

/**
 * `--data-dir` → `PIPELINE_DATA_DIR` → 미지정 순으로 데이터 디렉터리를 고른다.
 * `sync-neo4j`(`neo4j/sync.ts`)와 `resolve-graph`(`resolve/cli.ts`)가 같은 우선순위를 써야 한다 —
 * 어긋나면 `resolve-graph` 가 dry-run 으로 미리 보여준 입력과 `sync-neo4j` 가 실제로 적재하는
 * 입력이 달라져, "적재 전에 무엇이 합쳐지는지 미리 본다"는 이 단계의 존재 이유가 깨진다.
 * `resolve/` 가 `neo4j/` 를 몰라야 하므로(CLAUDE.md), 이 함수는 둘 다 이미 의존하는
 * `cli-options.ts` 에 둔다 — 어느 한쪽에 두면 다른 쪽이 그쪽을 import 해야 한다.
 */
export function readDataDirFlag(args: readonly string[]): string | undefined {
  return readFlag(args, "--data-dir") ?? process.env.PIPELINE_DATA_DIR;
}
