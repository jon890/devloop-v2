import type {
  GraphStatsResponse,
  NeighborsResponse,
  QueryRequest,
  QueryResponse,
} from '@devloop/shared';
import { mockNeighbors, mockQueryResponse, mockStatsResponse } from './fixtures';

export const useMockApi = import.meta.env.VITE_USE_MOCK === '1';

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`요청을 처리하지 못했습니다 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function getGraphStats(): Promise<GraphStatsResponse> {
  if (useMockApi) {
    await wait(180);
    return mockStatsResponse;
  }
  return request<GraphStatsResponse>('/api/graph/stats');
}

export async function queryGraph(question: string): Promise<QueryResponse> {
  const payload: QueryRequest = { question };
  if (useMockApi) {
    await wait(620);
    return mockQueryResponse;
  }
  return request<QueryResponse>('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function getNeighbors(nodeId: string): Promise<NeighborsResponse> {
  if (useMockApi) {
    await wait(360);
    return mockNeighbors(nodeId);
  }
  return request<NeighborsResponse>(`/api/graph/nodes/${encodeURIComponent(nodeId)}/neighbors?depth=1`);
}
