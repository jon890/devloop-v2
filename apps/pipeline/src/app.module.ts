import { Module } from '@nestjs/common';
import { ExtractModule } from './extract/extract.module';
import { IngestModule } from './ingest/ingest.module';
import { LoadModule } from './load/load.module';

@Module({
  imports: [IngestModule, ExtractModule, LoadModule],
})
export class AppModule {}
