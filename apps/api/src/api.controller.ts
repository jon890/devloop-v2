import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  GraphSearchResponse,
  GraphStatsResponse,
  NeighborsResponse,
  QueryRequest,
  QueryResponse,
} from '@devloop/shared';
import { GraphQueryService } from './graph-query.service';

@Controller('api')
export class ApiController {
  constructor(private readonly graphQueryService: GraphQueryService) {}

  @Post('query')
  query(@Body() request: QueryRequest): Promise<QueryResponse> {
    return this.graphQueryService.query(request);
  }

  @Get('graph/stats')
  stats(): Promise<GraphStatsResponse> {
    return this.graphQueryService.stats();
  }

  @Get('graph/nodes/:id/neighbors')
  neighbors(@Param('id') id: string, @Query('depth') depth = '1'): Promise<NeighborsResponse> {
    return this.graphQueryService.neighbors(id, depth);
  }

  @Get('graph/search')
  search(@Query('q') q = ''): Promise<GraphSearchResponse> {
    return this.graphQueryService.search(q);
  }

  @Get('graph/samples')
  samples(
    @Query('label') label = '',
    @Query('relationship') relationship = '',
  ): Promise<NeighborsResponse> {
    return this.graphQueryService.samples(label, relationship);
  }
}
