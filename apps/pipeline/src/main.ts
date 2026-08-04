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
import { AppServerCliAdapter, ClaudeCliAdapter, type LlmCli } from "./llm";
import { runExportCuration } from "./registry/export-curation";
import { runImportCuration } from "./registry/import-curation";
import { runRegisterProject } from "./registry/register-project";

/**
 * `codex` 는 상주 app-server 를 띄우므로 비동기다.
 * 서버를 죽이는 것은 어댑터 자신이다 — 호출자는 `close?.()` 만 부른다.
 */
async function llmAdapter(provider: PipelineConfig["llm"]["provider"]): Promise<LlmCli> {
  if (provider === "codex") return AppServerCliAdapter.start(resolveRepositoryRoot());
  if (provider === "claude") return new ClaudeCliAdapter();
  throw new Error(`Unsupported LLM_PROVIDER=${provider}; expected codex or claude.`);
}

const KNOWN_STAGES = ["fetch-dooray", "seed-concepts", "parse-structure", "infer-knowledge", "all"];
const REGISTRY_COMMANDS = ["register-project", "import-curation", "export-curation"];

async function bootstrap(): Promise<void> {
  const options = parsePipelineOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ["error", "warn"],
  });
  const config = app.get<PipelineConfig>(PIPELINE_CONFIG);
  const dataRoot = resolvePipelineDataRoot();
  const stage = options.stage ?? "all";
  try {
    if (stage === "register-project") {
      await runRegisterProject(process.argv.slice(3), config);
      return;
    }
    if (stage === "import-curation") {
      process.exitCode = await runImportCuration(process.argv.slice(3), config);
      return;
    }
    if (stage === "export-curation") {
      await runExportCuration(process.argv.slice(3), config);
      return;
    }
    if (!KNOWN_STAGES.includes(stage)) {
      throw new Error(`Unknown pipeline stage: ${stage}. Registry commands: ${REGISTRY_COMMANDS.join(", ")}.`);
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
      console.log(
        `Structural extraction complete: nodes=${result.nodes} relationships=${result.relationships} truncatedTaskBodies=${result.truncatedTaskBodies} truncatedComments=${result.truncatedComments} output=${result.outputPath}`,
      );
    }
    if (stage === "infer-knowledge" || stage === "all") {
      const model = config.llm.model;
      if (!model) throw new Error("LLM_MODEL is required for LLM extraction.");
      // 서버는 이 단계에서만 산다. 예외로 끝나도 자식 app-server 를 남기지 않도록 finally 로 닫는다.
      const llm = await llmAdapter(config.llm.provider);
      try {
        const result = await extractLlm({
          dataRoot,
          project: options.project,
          config,
          model,
          llm,
          concurrency: config.llm.concurrency,
          timeoutMs: config.llm.timeoutMs,
          docFilter: options.docs,
        });
        console.log(
          `LLM extraction complete: documents=${result.documents} processed=${result.processed} ` +
            `cacheHits=${result.cacheHits} failed=${result.failed.length} calls=${result.calls} ` +
            `rewrittenRelationships=${result.rewrittenRelationships} ` +
            `droppedRelationships=${result.droppedRelationships.count} output=${result.outputPath} ` +
            `droppedReport=${result.droppedRelationshipsReportPath}`,
        );
      } finally {
        await llm.close?.();
      }
    }
  } finally {
    await app.close();
  }
}

export function resolvePipelineDataRoot(): string {
  return path.resolve(__dirname, "../data");
}

/** 상주 app-server 의 읽기 범위다. `sandbox: "read-only"` 라 쓰기는 막혀 있다. */
export function resolveRepositoryRoot(): string {
  return path.resolve(__dirname, "../../..");
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
