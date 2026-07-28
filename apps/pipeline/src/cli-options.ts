export const DEFAULT_PROJECT = "tc-ocr";

export interface PipelineOptions {
  project: string;
  stage?: string;
  limit?: number;
  /** LLM 추출 부분 실행용 sourceDocId 목록 (--docs Task:483,Wiki:123) */
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
