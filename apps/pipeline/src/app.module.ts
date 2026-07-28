import { Module } from "@nestjs/common";
import { IngestModule } from "./fetch/ingest.module";

@Module({
  imports: [IngestModule],
})
export class AppModule {}
