import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { API_CONFIG, ROOT_ENV_PATH } from "./api-config.const";
import { validateApiConfig, type ApiConfig } from "./api-config.schema";

/**
 * 저장소 루트 `.env` 를 읽어 검증한 뒤 API_CONFIG 로 제공한다.
 * 검증 실패는 예외로 올라가 기동 자체를 막는다.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ROOT_ENV_PATH,
      validate: validateApiConfig,
      cache: true,
    }),
  ],
  providers: [
    {
      provide: API_CONFIG,
      useFactory: (configService: ConfigService): ApiConfig => ({
        port: configService.getOrThrow("port"),
        neo4j: configService.getOrThrow("neo4j"),
        llm: configService.getOrThrow("llm"),
      }),
      inject: [ConfigService],
    },
  ],
  exports: [API_CONFIG],
})
export class ApiConfigModule {}
