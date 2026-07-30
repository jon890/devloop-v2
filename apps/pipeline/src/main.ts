import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import path from "node:path";
import { AppModule } from "./app.module";
import { parsePipelineOptions } from "./cli-options";
import { PIPELINE_CONFIG, type PipelineConfig } from "./config";
import { IngestService } from "./fetch/ingest.service";
import { seedConcepts } from "./concepts/concept-seeder";
import { extractLlm } from "./infer/llm-extractor";
import { extractStructural } from "./parse/structural-extractor";
import { ClaudeCliAdapter, CodexCliAdapter, type LlmCli } from "./llm";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function llmAdapter(): LlmCli {
  const provider = process.env.LLM_PROVIDER ?? "codex";
  if (provider === "codex") return new CodexCliAdapter();
  if (provider === "claude") return new ClaudeCliAdapter();
  throw new Error(`Unsupported LLM_PROVIDER=${provider}; expected codex or claude.`);
}

const KNOWN_STAGES = ["fetch-dooray", "seed-concepts", "parse-structure", "infer-knowledge", "all"];

async function bootstrap(): Promise<void> {
  const options = parsePipelineOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ["error", "warn"],
  });
  const config = app.get<PipelineConfig>(PIPELINE_CONFIG);
  const dataRoot = path.resolve(__dirname, "../data");
  const stage = options.stage ?? "all";
  try {
    if (!KNOWN_STAGES.includes(stage)) {
      throw new Error(`Unknown pipeline stage: ${stage}`);
    }
    if (stage === "fetch-dooray" || stage === "all") {
      const result = await app.get(IngestService).ingest({
        project: options.project,
        config,
        limit: options.limit,
      });
      const { posts, wiki, tags, members } = result.stats;
      console.log(`수집 파일 수: posts=${posts} wiki=${wiki} tags=${tags} members=${members}`);

      if (result.failures.length > 0) {
        console.error(`수집 실패 ${result.failures.length}건:`);
        for (const failure of result.failures) {
          console.error(`- ${failure.item}: ${failure.command}: ${failure.error}`);
        }
        process.exitCode = 1;
        return;
      }
      if (stage === "fetch-dooray") return;
    }
    if (stage === "seed-concepts" || stage === "all") {
      const result = await seedConcepts({ dataRoot, project: options.project, config });
      console.log(`Concept seed complete: project=${options.project} concepts=${result.concepts.length} output=${result.outputPath}`);
    }
    if (stage === "parse-structure" || stage === "all") {
      const result = await extractStructural({ dataRoot, project: options.project, config });
      console.log(`Structural extraction complete: nodes=${result.nodes} relationships=${result.relationships} output=${result.outputPath}`);
    }
    if (stage === "infer-knowledge" || stage === "all") {
      const model = process.env.LLM_MODEL;
      if (!model) throw new Error("LLM_MODEL is required for LLM extraction.");
      const result = await extractLlm({
        dataRoot,
        project: options.project,
        config,
        model,
        llm: llmAdapter(),
        concurrency: positiveInteger(process.env.LLM_CONCURRENCY, 4),
        timeoutMs: positiveInteger(process.env.LLM_TIMEOUT_MS, 120_000),
        docFilter: options.docs,
      });
      console.log(
        `LLM extraction complete: documents=${result.documents} processed=${result.processed} ` +
          `cacheHits=${result.cacheHits} failed=${result.failed.length} calls=${result.calls} ` +
          `rewrittenRelationships=${result.rewrittenRelationships} ` +
          `droppedRelationships=${result.droppedRelationships.count} output=${result.outputPath} ` +
          `droppedReport=${result.droppedRelationshipsReportPath}`,
      );
    }
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
