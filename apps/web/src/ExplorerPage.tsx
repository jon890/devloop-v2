import type { GraphNode, GraphRel } from '@devloop/shared';
import { FormEvent, useMemo, useState } from 'react';
import { getNeighbors, searchGraph } from './api-client';
import { GraphCanvas, labelColors, legendItems } from './GraphCanvas';

type GraphSnapshot = {
  nodes: GraphNode[];
  relationships: GraphRel[];
  selectedNodeId: string | null;
};

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return Array.from(new Map([...current, ...incoming].map((item) => [item.id, item])).values());
}

export function ExplorerPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GraphNode[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [relationships, setRelationships] = useState<GraphRel[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [history, setHistory] = useState<GraphSnapshot[]>([]);
  const [searching, setSearching] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId)
      ?? results.find((node) => node.id === selectedNodeId)
      ?? null,
    [nodes, results, selectedNodeId],
  );
  const evidenceIds = useMemo(
    () => new Set(selectedNodeId ? [selectedNodeId] : []),
    [selectedNodeId],
  );

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = query.trim();
    if (!nextQuery || searching) return;

    setSearching(true);
    setError(null);
    try {
      const response = await searchGraph(nextQuery);
      setResults(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '노드를 검색하지 못했습니다.');
    } finally {
      setSearching(false);
    }
  };

  const selectSearchResult = (node: GraphNode) => {
    setNodes([node]);
    setRelationships([]);
    setSelectedNodeId(node.id);
    setHistory([]);
  };

  const expandNode = async (nodeId: string) => {
    if (expandingId) return;
    setSelectedNodeId(nodeId);
    setExpandingId(nodeId);
    setError(null);
    try {
      const neighbors = await getNeighbors(nodeId);
      setHistory((current) => [
        ...current,
        { nodes, relationships, selectedNodeId: nodeId },
      ]);
      setNodes((current) => mergeById(current, neighbors.nodes));
      setRelationships((current) => mergeById(current, neighbors.relationships));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '이웃 노드를 불러오지 못했습니다.');
    } finally {
      setExpandingId(null);
    }
  };

  const undoExpansion = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setNodes(previous.nodes);
    setRelationships(previous.relationships);
    setSelectedNodeId(previous.selectedNodeId);
    setHistory((current) => current.slice(0, -1));
  };

  return (
    <section className="explorer-page page-surface">
      <aside className="explorer-sidebar">
        <div className="page-heading compact">
          <span className="section-kicker">인스턴스 탐색</span>
          <h2>이름으로 찾고, 연결을 따라갑니다</h2>
          <p>업무·개념·위키를 검색한 뒤 한 단계씩 이웃을 펼쳐 실제 지식의 경로를 확인합니다.</p>
        </div>

        <form className="graph-search-form" onSubmit={submitSearch}>
          <label htmlFor="graph-search">노드 검색</label>
          <div>
            <input
              id="graph-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="예: Graph API, 모델 서버"
            />
            <button type="submit" disabled={searching || !query.trim()}>
              {searching ? '검색 중' : '검색'}
            </button>
          </div>
        </form>

        {error && <div className="error-message" role="alert">{error}</div>}

        <div className="search-results" aria-live="polite">
          <div className="result-heading">
            <span>검색 결과</span>
            <small>{results.length ? `${results.length}개` : '검색어를 입력하세요'}</small>
          </div>
          {results.length > 0 ? (
            <ul>
              {results.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    className={selectedNodeId === node.id ? 'active' : ''}
                    onClick={() => selectSearchResult(node)}
                  >
                    <i style={{ background: labelColors[node.label] }} />
                    <span><small>{node.label}</small><strong>{node.display}</strong></span>
                    <span aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="result-empty">찾고 싶은 업무 제목이나 개념 이름을 입력하세요.</div>
          )}
        </div>

        {selectedNode && (
          <article className="selected-node-card">
            <div>
              <span style={{ background: labelColors[selectedNode.label] }}>{selectedNode.label}</span>
              <strong>{selectedNode.display}</strong>
              <small>키 · {selectedNode.key}</small>
            </div>
            <button
              type="button"
              onClick={() => expandNode(selectedNode.id)}
              disabled={expandingId !== null}
            >
              {expandingId === selectedNode.id ? '이웃 불러오는 중' : '이웃 1단계 확장'}
            </button>
          </article>
        )}
      </aside>

      <section className="explorer-graph">
        <div className="explorer-toolbar">
          <div>
            <span className="section-kicker light">라이브 그래프</span>
            <p>{nodes.length}개 노드 · {relationships.length}개 관계</p>
          </div>
          <button type="button" onClick={undoExpansion} disabled={!history.length}>
            <span aria-hidden="true">↶</span> 이전 확장 되돌리기
          </button>
        </div>

        <GraphCanvas
          nodes={nodes}
          relationships={relationships}
          evidenceIds={evidenceIds}
          focusedNodeId={selectedNodeId}
          onNodeClick={expandNode}
          includeIsolatedNodes
        />

        {!nodes.length && (
          <div className="explorer-empty">
            <svg className="path-symbol" viewBox="0 0 106 28" aria-hidden="true">
              <line x1="6.5" y1="22" x2="99.5" y2="6" />
              <circle cx="6.5" cy="22" r="5.5" className="path-node first" />
              <circle cx="53.5" cy="14" r="5.5" className="path-node middle" />
              <circle cx="99.5" cy="6" r="5.5" className="path-node last" />
            </svg>
            <h3>탐색할 노드를 선택하세요</h3>
            <p>선택한 노드에서 시작해 관계의 방향과 주변 맥락을 펼칠 수 있습니다.</p>
          </div>
        )}

        <div className="legend explorer-legend" aria-label="노드 라벨 범례">
          {legendItems.map((item) => (
            <span key={item.label}><i style={{ background: item.color }} />{item.name}</span>
          ))}
        </div>
        <p className="graph-hint">노드 클릭으로 바로 이웃 확장 · 상단 버튼으로 한 단계 되돌리기</p>
      </section>
    </section>
  );
}
