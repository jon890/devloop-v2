import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { parsePipelineOptions } from './cli-options';

async function bootstrap(): Promise<void> {
  const options = parsePipelineOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  console.log(`Pipeline scaffold ready: project=${options.project}, stage=${options.stage ?? 'all'}`);
  await app.close();
}

void bootstrap();
