import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { API_CONFIG, type ApiConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ApiConfig>(API_CONFIG);
  await app.listen(config.port);
}

void bootstrap();
