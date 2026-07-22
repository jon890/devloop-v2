import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import path from 'node:path';
import { AppModule } from './app.module';
import { parsePipelineOptions } from './cli-options';
import { seedConcepts } from './extract/concept-seeder';
import { extractLlm } from './extract/llm-extractor';
import { extractStructural } from './extract/structural-extractor';
import { ClaudeCliAdapter, CodexCliAdapter, type LlmCli } from './llm';

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function llmAdapter(): LlmCli {
  const provider = process.env.LLM_PROVIDER ?? 'codex';
  if (provider === 'codex') return new CodexCliAdapter();
  if (provider === 'claude') return new ClaudeCliAdapter();
  throw new Error(`Unsupported LLM_PROVIDER=${provider}; expected codex or claude.`);
}

async function bootstrap(): Promise<void> {
  const options = parsePipelineOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const dataRoot = path.resolve(__dirname, '../data');
  const stage = options.stage ?? 'all';
  try {
    if (stage === 'concepts:seed' || stage === 'extract' || stage === 'all') {
      const result = await seedConcepts({ dataRoot, project: options.project });
      console.log(`Concept seed complete: project=${options.project} concepts=${result.concepts.length} output=${result.outputPath}`);
    }
    if (stage === 'extract:structural' || stage === 'extract' || stage === 'all') {
      const result = await extractStructural({ dataRoot, project: options.project });
      console.log(`Structural extraction complete: nodes=${result.nodes} relationships=${result.relationships} output=${result.outputPath}`);
    }
    if (stage === 'extract:llm' || stage === 'extract' || stage === 'all') {
      const model = process.env.LLM_MODEL;
      if (!model) throw new Error('LLM_MODEL is required for LLM extraction.');
      const result = await extractLlm({
        dataRoot,
        project: options.project,
        model,
        llm: llmAdapter(),
        concurrency: positiveInteger(process.env.LLM_CONCURRENCY, 4),
        timeoutMs: positiveInteger(process.env.LLM_TIMEOUT_MS, 120_000),
      });
      console.log(`LLM extraction complete: documents=${result.documents} processed=${result.processed} cacheHits=${result.cacheHits} failed=${result.failed.length} calls=${result.calls} output=${result.outputPath}`);
    }
    if (!['concepts:seed', 'extract:structural', 'extract:llm', 'extract', 'all'].includes(stage)) {
      throw new Error(`Unknown pipeline stage: ${stage}`);
    }
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
