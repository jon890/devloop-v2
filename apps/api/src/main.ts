import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { API_CONFIG, type ApiConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // SIGTERM·SIGINT 로 종료할 때 상주 app-server 를 죽이려면 종료 훅을 켜야 한다.
  app.enableShutdownHooks();
  const config = app.get<ApiConfig>(API_CONFIG);
  await app.listen(config.port);
}

void bootstrap();
