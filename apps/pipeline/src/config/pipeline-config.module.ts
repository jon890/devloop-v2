import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { PIPELINE_CONFIG, ROOT_ENV_PATH } from "./pipeline-config.const";
import { validatePipelineConfig, type PipelineConfig } from "./pipeline-config.schema";

/**
 * 저장소 루트 `.env` 를 읽어 검증한 뒤 PIPELINE_CONFIG 로 제공한다.
 * 현재 스키마는 비어 있고, 다음 phase 들이 값을 하나씩 추가한다.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ROOT_ENV_PATH,
      validate: validatePipelineConfig,
      cache: true,
    }),
  ],
  providers: [
    {
      provide: PIPELINE_CONFIG,
      useFactory: (configService: ConfigService): PipelineConfig => configService.getOrThrow("pipeline"),
      inject: [ConfigService],
    },
  ],
  exports: [PIPELINE_CONFIG],
})
export class PipelineConfigModule {}

export async function withPipelineConfig<T>(run: (config: PipelineConfig) => Promise<T>): Promise<T> {
  const app = await NestFactory.createApplicationContext(PipelineConfigModule, {
    abortOnError: false,
    logger: ["error", "warn"],
  });
  try {
    return await run(app.get<PipelineConfig>(PIPELINE_CONFIG));
  } finally {
    await app.close();
  }
}
