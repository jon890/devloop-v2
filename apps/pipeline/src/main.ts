import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { parsePipelineOptions } from './cli-options';
import { IngestService } from './ingest/ingest.service';

async function bootstrap(): Promise<void> {
  const options = parsePipelineOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    if (options.stage === 'ingest') {
      const result = await app.get(IngestService).ingest({
        project: options.project,
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
      }
      return;
    }

    console.log(`Pipeline scaffold ready: project=${options.project}, stage=${options.stage ?? 'all'}`);
  } finally {
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
