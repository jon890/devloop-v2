import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { PIPELINE_CONFIG, ROOT_ENV_PATH, validatePipelineConfig, type PipelineConfig } from ".";

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    NEO4J_URI: "bolt://localhost:7690",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env as Record<string, string>;
}

test("NEO4J_URI 가 있으면 설정으로 파싱된다", () => {
  const validated = validatePipelineConfig(validEnv());

  assert.deepEqual(validated, {
    pipeline: {
      neo4j: {
        uri: "bolt://localhost:7690",
        user: "neo4j",
        password: "devloop-password",
      },
      llm: {
        provider: "codex",
        model: undefined,
        reasoningEffort: undefined,
        concurrency: 4,
        timeoutMs: 120_000,
      },
      pipelineDataDir: undefined,
    },
  });
});

test("NEO4J_URI 가 없어도 전역 설정 파싱은 성공한다", () => {
  const config = validatePipelineConfig(validEnv({ NEO4J_URI: undefined })).pipeline;

  assert.equal(config.neo4j.uri, undefined);
});

test("알 수 없는 환경변수는 PipelineConfig 로 새지 않는다", () => {
  const validated = validatePipelineConfig({
    ...validEnv(),
    LLM_MODEL: "gpt-5.5",
    PIPELINE_DATA_DIR: "/tmp/devloop-data",
  });

  assert.deepEqual(Object.keys(validated.pipeline).sort(), ["llm", "neo4j", "pipelineDataDir"]);
  assert.deepEqual(Object.keys(validated.pipeline.neo4j).sort(), ["password", "uri", "user"]);
});

test("LLM 선택 값은 기본값과 지정값을 파싱한다", () => {
  const defaults = validatePipelineConfig(validEnv()).pipeline;
  assert.equal(defaults.llm.provider, "codex");
  assert.equal(defaults.llm.model, undefined);
  assert.equal(defaults.llm.reasoningEffort, undefined);
  assert.equal(defaults.llm.concurrency, 4);
  assert.equal(defaults.llm.timeoutMs, 120_000);

  const configured = validatePipelineConfig(
    validEnv({
      LLM_PROVIDER: "claude",
      LLM_MODEL: "gpt-5.5",
      LLM_REASONING_EFFORT: "high",
      LLM_CONCURRENCY: "8",
      LLM_TIMEOUT_MS: "30000",
      PIPELINE_DATA_DIR: "/tmp/devloop-data",
    }),
  ).pipeline;
  assert.deepEqual(configured.llm, {
    provider: "claude",
    model: "gpt-5.5",
    reasoningEffort: "high",
    concurrency: 8,
    timeoutMs: 30_000,
  });
  assert.equal(configured.pipelineDataDir, "/tmp/devloop-data");
});

test("LLM_PROVIDER 오타와 잘못된 effort는 거부한다", () => {
  assert.throws(() => validatePipelineConfig(validEnv({ LLM_PROVIDER: "codexx" })), /LLM_PROVIDER/);
  assert.throws(() => validatePipelineConfig(validEnv({ LLM_REASONING_EFFORT: "extreme" })), /LLM_REASONING_EFFORT/);
});

test("빈 LLM_PROVIDER 와 빈 LLM_REASONING_EFFORT 는 기본값으로 바꾸지 않고 거부한다", () => {
  assert.throws(() => validatePipelineConfig(validEnv({ LLM_PROVIDER: "" })), /LLM_PROVIDER/);
  assert.throws(() => validatePipelineConfig(validEnv({ LLM_REASONING_EFFORT: "" })), /LLM_REASONING_EFFORT/);
});

test("LLM_CONCURRENCY 와 LLM_TIMEOUT_MS 는 양의 정수여야 한다", () => {
  for (const value of ["0", "-1", "1.5", "not-a-number", " "]) {
    assert.throws(() => validatePipelineConfig(validEnv({ LLM_CONCURRENCY: value })), /LLM_CONCURRENCY/);
    assert.throws(() => validatePipelineConfig(validEnv({ LLM_TIMEOUT_MS: value })), /LLM_TIMEOUT_MS/);
  }
});

test("빈 LLM_CONCURRENCY 와 LLM_TIMEOUT_MS 는 기본값을 쓴다", () => {
  const config = validatePipelineConfig(validEnv({ LLM_CONCURRENCY: "", LLM_TIMEOUT_MS: "" })).pipeline;

  assert.equal(config.llm.concurrency, 4);
  assert.equal(config.llm.timeoutMs, 120_000);
});

test("문자열 설정은 공백과 빈 문자열을 원문 그대로 보존한다", () => {
  const config = validatePipelineConfig(
    validEnv({
      NEO4J_USER: " user ",
      NEO4J_PASSWORD: " password ",
      LLM_MODEL: "",
      PIPELINE_DATA_DIR: " ",
    }),
  ).pipeline;

  assert.equal(config.neo4j.user, " user ");
  assert.equal(config.neo4j.password, " password ");
  assert.equal(config.llm.model, "");
  assert.equal(config.pipelineDataDir, " ");
});

test("Neo4j 자격증명은 NEO4J_AUTH 기본값을 쓴다", () => {
  const config = validatePipelineConfig(validEnv()).pipeline;

  assert.equal(config.neo4j.user, "neo4j");
  assert.equal(config.neo4j.password, "devloop-password");
});

test("Neo4j 자격증명은 NEO4J_AUTH 를 user/password 로 나눈다", () => {
  const config = validatePipelineConfig(validEnv({ NEO4J_AUTH: "reader/secret" })).pipeline;

  assert.equal(config.neo4j.user, "reader");
  assert.equal(config.neo4j.password, "secret");
});

test("빈 NEO4J_AUTH 도 이전과 같이 빈 사용자와 기본 비밀번호로 해석한다", () => {
  const config = validatePipelineConfig(validEnv({ NEO4J_AUTH: "" })).pipeline;

  assert.equal(config.neo4j.user, "");
  assert.equal(config.neo4j.password, "devloop-password");
});

test("NEO4J_USER 와 NEO4J_PASSWORD 쌍이 NEO4J_AUTH 보다 우선한다", () => {
  const config = validatePipelineConfig(
    validEnv({ NEO4J_AUTH: "auth-user/auth-password", NEO4J_USER: "pair-user", NEO4J_PASSWORD: "pair-password" }),
  ).pipeline;

  assert.equal(config.neo4j.user, "pair-user");
  assert.equal(config.neo4j.password, "pair-password");
});

test("NEO4J_USER 와 NEO4J_PASSWORD 중 하나만 있으면 기존처럼 NEO4J_AUTH 로 돌아간다", () => {
  const onlyUser = validatePipelineConfig(validEnv({ NEO4J_AUTH: "auth-user/auth-password", NEO4J_USER: "pair-user" })).pipeline;
  const onlyPassword = validatePipelineConfig(validEnv({ NEO4J_AUTH: "auth-user/auth-password", NEO4J_PASSWORD: "pair-password" })).pipeline;

  assert.deepEqual(onlyUser.neo4j, { uri: "bolt://localhost:7690", user: "auth-user", password: "auth-password" });
  assert.deepEqual(onlyPassword.neo4j, { uri: "bolt://localhost:7690", user: "auth-user", password: "auth-password" });
});

test("ROOT_ENV_PATH 는 cwd 와 무관하게 저장소 루트 .env 를 가리킨다", () => {
  assert.equal(ROOT_ENV_PATH, resolve(__dirname, "../../../..", ".env"));
});

test("프로세스 환경이 .env 보다 우선한다", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "pipeline-config-"));
  const envFilePath = resolve(tempDir, ".env");
  const original = process.env.NEO4J_URI;
  process.env.NEO4J_URI = "bolt://from-process:7690";

  try {
    await writeFile(envFilePath, "NEO4J_URI=bolt://from-env-file:7690\n", "utf8");
    await withConfigService(envFilePath, (service) => {
      assert.equal(service.get<PipelineConfig>("pipeline")?.neo4j.uri, "bolt://from-process:7690");
    });
  } finally {
    if (original === undefined) {
      delete process.env.NEO4J_URI;
    } else {
      process.env.NEO4J_URI = original;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test(".env 가 없어도 프로세스 환경에 NEO4J_URI 가 있으면 설정에 반영된다", async () => {
  const missingEnvPath = resolve(tmpdir(), `devloop-missing-${process.pid}-${Date.now()}.env`);
  await withEnv("NEO4J_URI", "bolt://process-only:7690", () =>
    withConfigService(missingEnvPath, (service) => {
      assert.equal(service.get<PipelineConfig>("pipeline")?.neo4j.uri, "bolt://process-only:7690");
    }),
  );
});

test(".env 가 없고 프로세스 환경에도 NEO4J_URI 가 없어도 기동한다", async () => {
  const missingEnvPath = resolve(tmpdir(), `devloop-missing-${process.pid}-${Date.now()}-required.env`);
  await withEnv("NEO4J_URI", undefined, async () => {
    await withConfigService(missingEnvPath, (service) => {
      assert.equal(service.get<PipelineConfig>("pipeline")?.neo4j.uri, undefined);
    });
  });
});

test("PIPELINE_CONFIG 토큰으로 검증된 설정 객체를 주입한다", async () => {
  await withEnv("NEO4J_URI", "bolt://localhost:7690", async () => {
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

    const app = await NestFactory.createApplicationContext(TestModule, { abortOnError: false, logger: false });
    try {
      assert.deepEqual(app.get<PipelineConfig>(PIPELINE_CONFIG), {
        neo4j: {
          uri: "bolt://localhost:7690",
          user: "neo4j",
          password: "devloop-password",
        },
        llm: {
          provider: "codex",
          model: undefined,
          reasoningEffort: undefined,
          concurrency: 4,
          timeoutMs: 120_000,
        },
        pipelineDataDir: undefined,
      });
    } finally {
      await app.close();
    }
  });
});

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

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

  const app = await NestFactory.createApplicationContext(TestModule, { abortOnError: false, logger: false });
  try {
    assertion(app.get(ConfigService));
  } finally {
    await app.close();
  }
}
