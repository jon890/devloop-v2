import type { GraphNode, GraphRel, QueryResponse } from '@devloop/shared';
import { FormEvent, useCallback, useMemo, useState } from 'react';
import { getNeighbors, queryGraph } from '../api-client';
import { initialQuestion } from './query.const';

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return Array.from(new Map([...current, ...incoming].map((item) => [item.id, item])).values());
}

export function useQueryWorkspace({ onSubmitStart }: { onSubmitStart?: () => void } = {}) {
  const [question, setQuestion] = useState(initialQuestion);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [relationships, setRelationships] = useState<GraphRel[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const evidenceIds = useMemo(
    () => new Set(result?.evidence.nodes.map((node) => node.id) ?? []),
    [result],
  );

  const submitQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion || loading) return;

    setLoading(true);
    onSubmitStart?.();
    setError(null);
    try {
      const response = await queryGraph(nextQuestion);
      setResult(response);
      setNodes(response.evidence.nodes);
      setRelationships(response.evidence.relationships);
      setFocusedNodeId(response.evidence.nodes[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '질문을 처리하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const focusEvidence = (nodeId: string) => {
    setFocusedNodeId(null);
    window.requestAnimationFrame(() => setFocusedNodeId(nodeId));
  };

  const expandNode = useCallback(async (nodeId: string) => {
    if (expandingId) return;
    setFocusedNodeId(nodeId);
    setExpandingId(nodeId);
    setError(null);
    try {
      const neighbors = await getNeighbors(nodeId);
      setNodes((current) => mergeById(current, neighbors.nodes));
      setRelationships((current) => mergeById(current, neighbors.relationships));
      window.requestAnimationFrame(() => setFocusedNodeId(nodeId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '이웃 노드를 불러오지 못했습니다.');
    } finally {
      setExpandingId(null);
    }
  }, [expandingId]);

  return {
    question,
    setQuestion,
    result,
    nodes,
    relationships,
    focusedNodeId,
    loading,
    expandingId,
    error,
    evidenceIds,
    submitQuestion,
    focusEvidence,
    expandNode,
  };
}
