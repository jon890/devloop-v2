export const DEFAULT_PROJECT = 'tc-ocr';

export interface PipelineOptions {
  project: string;
  stage?: string;
}

export function parsePipelineOptions(args: readonly string[]): PipelineOptions {
  const projectFlagIndex = args.indexOf('--project');
  const project = projectFlagIndex >= 0 ? args[projectFlagIndex + 1] : undefined;
  const stage = args.find((arg) => !arg.startsWith('-') && arg !== project);

  return {
    project: project?.trim() || DEFAULT_PROJECT,
    stage,
  };
}
