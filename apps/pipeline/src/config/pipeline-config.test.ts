import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { PIPELINE_CONFIG, ROOT_ENV_PATH, validatePipelineConfig, type PipelineConfig } from ".";

test("빈 스키마로 시작한다 — 알 수 없는 환경변수는 PipelineConfig 로 새지 않는다", () => {
  const validated = validatePipelineConfig({
    NEO4J_URI: "bolt://env-file:7687",
    LLM_MODEL: "gpt-5.5",
    PIPELINE_DATA_DIR: "/tmp/devloop-data",
  });

  assert.deepEqual(validated, { pipeline: {} });
});

test("ROOT_ENV_PATH 는 cwd 와 무관하게 저장소 루트 .env 를 가리킨다", () => {
  assert.equal(ROOT_ENV_PATH, resolve(__dirname, "../../../..", ".env"));
});

test("프로세스 환경이 .env 보다 우선한다", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "pipeline-config-"));
  const envFilePath = resolve(tempDir, ".env");
  const original = process.env.PIPELINE_CONFIG_PRIORITY_PROBE;
  process.env.PIPELINE_CONFIG_PRIORITY_PROBE = "from-process";

  try {
    await writeFile(envFilePath, "PIPELINE_CONFIG_PRIORITY_PROBE=from-env-file\n", "utf8");
    await withConfigService(envFilePath, (service) => {
      assert.equal(service.get("PIPELINE_CONFIG_PRIORITY_PROBE"), "from-process");
    });
  } finally {
    if (original === undefined) {
      delete process.env.PIPELINE_CONFIG_PRIORITY_PROBE;
    } else {
      process.env.PIPELINE_CONFIG_PRIORITY_PROBE = original;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(".env 가 없어도 빈 설정 모듈은 기동한다", async () => {
  const missingEnvPath = resolve(tmpdir(), `devloop-missing-${process.pid}-${Date.now()}.env`);
  await withConfigService(missingEnvPath, (service) => {
    assert.deepEqual(service.get<PipelineConfig>("pipeline"), {});
  });
});

test("PIPELINE_CONFIG 토큰으로 빈 설정 객체를 주입한다", async () => {
  @Module({
    imports: [
      ConfigModule.forRoot({
        envFilePath: resolve(tmpdir(), `devloop-missing-${process.pid}-${Date.now()}-token.env`),
        validate: validatePipelineConfig,
      }),
    ],
    providers: [
      {
        provide: PIPELINE_CONFIG,
        useFactory: (configService: ConfigService): PipelineConfig => configService.getOrThrow("pipeline"),
        inject: [ConfigService],
      },
    ],
  })
  class TestModule {}

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  try {
    assert.deepEqual(app.get<PipelineConfig>(PIPELINE_CONFIG), {});
  } finally {
    await app.close();
  }
});

async function withConfigService(envFilePath: string, assertion: (service: ConfigService) => void): Promise<void> {
  @Module({
    imports: [
      ConfigModule.forRoot({
        envFilePath,
        validate: validatePipelineConfig,
      }),
    ],
  })
  class TestModule {}

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  try {
    assertion(app.get(ConfigService));
  } finally {
    await app.close();
  }
}
