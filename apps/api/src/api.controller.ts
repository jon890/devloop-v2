import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type {
  GraphNode,
  GraphSearchResponse,
  GraphStatsResponse,
  NeighborsResponse,
  QueryRequest,
  QueryResponse,
} from '@devloop/shared';

@Controller('api')
export class ApiController {
  @Post('query')
  query(@Body() request: QueryRequest): QueryResponse {
    void request;
    return {
      answer: '',
      evidence: { nodes: [], relationships: [] },
      cypher: '',
    };
  }

  @Get('graph/stats')
  stats(): GraphStatsResponse {
    return { nodes: {}, relationships: {} };
  }

  @Get('graph/nodes/:id/neighbors')
  neighbors(@Param('id') id: string, @Query('depth') depth = '1'): NeighborsResponse {
    void id;
    void depth;
    return { nodes: [], relationships: [] };
  }

  @Get('graph/search')
  search(@Query('q') q = ''): GraphSearchResponse {
    void q;
    return [] satisfies GraphNode[];
  }
}
