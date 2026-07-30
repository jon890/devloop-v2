import { Module } from "@nestjs/common";
import { PipelineConfigModule } from "./config";
import { IngestModule } from "./fetch/ingest.module";

@Module({
  imports: [PipelineConfigModule, IngestModule],
})
export class AppModule {}
