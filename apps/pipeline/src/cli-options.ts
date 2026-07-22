export const DEFAULT_PROJECT = 'tc-ocr';

export interface PipelineOptions {
  project: string;
  stage?: string;
  limit?: number;
}

export function parsePipelineOptions(args: readonly string[]): PipelineOptions {
  const project = optionValue(args, '--project');
  const limitValue = optionValue(args, '--limit');
  const optionValues = new Set([project, limitValue].filter((value): value is string => !!value));
  const stage = args.find((arg) => !arg.startsWith('-') && !optionValues.has(arg));

  let limit: number | undefined;
  if (limitValue !== undefined) {
    limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('--limit 값은 1 이상의 정수여야 합니다.');
    }
  }

  return {
    project: project?.trim() || DEFAULT_PROJECT,
    stage,
    limit,
  };
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} 값을 입력해야 합니다.`);
  }
  return value;
}
