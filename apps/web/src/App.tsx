import type { Evidence, GraphNode, GraphRel, GraphStatsResponse, QueryResponse } from '@devloop/shared';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { getGraphStats, getNeighbors, queryGraph, useMockApi } from './api-client';
import { ExplorerPage } from './ExplorerPage';
import { GraphCanvas, labelColors, legendItems } from './GraphCanvas';
import { OntologyPage } from './OntologyPage';
import { SchemaMapPage } from './SchemaMapPage';

const initialQuestion = '모델 서버 배포 전략은 어떻게 결정됐고, 확인할 위험은 무엇인가요?';
type ViewId = 'query' | 'ontology' | 'schema' | 'explorer';

const views: { id: ViewId; label: string }[] = [
  { id: 'query', label: '질의응답' },
  { id: 'ontology', label: '온톨로지 정의' },
  { id: 'schema', label: '스키마 맵' },
  { id: 'explorer', label: '인스턴스 탐색' },
];

const viewTitles: Record<ViewId, string> = {
  query: '결정의 맥락을 따라가세요',
  ontology: '지식의 계약을 읽습니다',
  schema: '구조와 규모를 함께 봅니다',
  explorer: '연결을 한 단계씩 펼칩니다',
};

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return Array.from(new Map([...current, ...incoming].map((item) => [item.id, item])).values());
}

function sum(values: Record<string, number> | undefined) {
  return Object.values(values ?? {}).reduce((total, count) => total + count, 0);
}

export function App() {
  const [view, setView] = useState<ViewId>('query');
  const [question, setQuestion] = useState(initialQuestion);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [relationships, setRelationships] = useState<GraphRel[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getGraphStats().then(setStats).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : '그래프 통계를 불러오지 못했습니다.');
    });
  }, []);

  const evidenceIds = useMemo(
    () => new Set(result?.evidence.nodes.map((node) => node.id) ?? []),
    [result],
  );

  const submitQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuestion = question.trim();
    if (!nextQuestion || loading) return;

    setLoading(true);
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

  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="topbar">
          <div className="brand-block">
            <svg className="brand-mark" viewBox="0 0 37 40" aria-hidden="true">
              <line x1="18.5" y1="6" x2="6" y2="34" />
              <line x1="18.5" y1="6" x2="31" y2="34" />
              <line x1="6" y1="34" x2="31" y2="34" />
              <circle cx="18.5" cy="6" r="6" className="brand-node top" />
              <circle cx="6" cy="34" r="6" className="brand-node left" />
              <circle cx="31" cy="34" r="6" className="brand-node right" />
            </svg>
            <div>
              <p className="eyebrow">Dooray knowledge map</p>
              <h1>{viewTitles[view]}</h1>
            </div>
          </div>
          <div className="stats" aria-label="전체 그래프 규모">
            <div><strong>{stats ? sum(stats.nodes).toLocaleString('ko-KR') : '—'}</strong><span>노드</span></div>
            <span className="stats-divider" />
            <div><strong>{stats ? sum(stats.relationships).toLocaleString('ko-KR') : '—'}</strong><span>관계</span></div>
            <span className={`mode-badge ${useMockApi ? 'mock' : ''}`}>{useMockApi ? 'MOCK' : 'LIVE API'}</span>
          </div>
        </div>
        <nav className="main-nav" aria-label="그래프 화면">
          {views.map((item) => (
            <button
              type="button"
              key={item.id}
              className={view === item.id ? 'active' : ''}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {view === 'query' && <section className="workspace">
        <aside className="chat-panel">
          <div className="panel-intro">
            <span className="section-kicker">질문</span>
            <p>업무, 결정, 담당자 사이의 연결을 자연어로 탐색합니다.</p>
          </div>

          <form className="question-form" onSubmit={submitQuestion}>
            <label htmlFor="question">무엇을 확인할까요?</label>
            <textarea
              id="question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="예: 배포 전략은 어떻게 결정됐나요?"
              rows={3}
            />
            <div className="form-footer">
              <span>Enter로 질문 · Shift + Enter로 줄바꿈</span>
              <button type="submit" disabled={loading || !question.trim()}>
                {loading ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">↗</span>}
                {loading ? '근거 찾는 중' : '질문하기'}
              </button>
            </div>
          </form>

          {error && <div className="error-message" role="alert">{error}</div>}

          <div className={`answer-stack ${result ? 'has-result' : ''}`} aria-live="polite">
            {!result && !loading && (
              <div className="empty-answer">
                <div className="empty-orbit" aria-hidden="true"><span /></div>
                <h2>답과 근거를 한 화면에서</h2>
                <p>질문하면 관련 결정과 업무를 추려 오른쪽 그래프에 표시합니다.</p>
              </div>
            )}

            {loading && (
              <div className="answer-skeleton" aria-label="답변을 만드는 중">
                <span /><span /><span />
              </div>
            )}

            {result && !loading && (
              <>
                <article className="answer-card">
                  <div className="answer-heading">
                    <span className="section-kicker">답변</span>
                    <span className="grounded-badge">근거 {result.evidence.nodes.length}개</span>
                  </div>
                  <p>{result.answer}</p>
                </article>

                <EvidenceList evidence={result.evidence} onFocus={focusEvidence} focusedId={focusedNodeId} />

                <details className="cypher-disclosure">
                  <summary><span>생성된 Cypher</span><small>질의 검증용</small></summary>
                  <pre><code>{result.cypher}</code></pre>
                </details>
              </>
            )}
          </div>
        </aside>

        <section className="graph-panel">
          <div className="graph-toolbar">
            <div>
              <span className="section-kicker light">근거 그래프</span>
              <p>{nodes.length ? `${nodes.length}개 노드 · ${relationships.length}개 관계` : '질문을 입력하면 그래프가 구성됩니다.'}</p>
            </div>
            {expandingId && <span className="expansion-status"><span className="spinner" /> 이웃 확장 중</span>}
          </div>

          <GraphCanvas
            nodes={nodes}
            relationships={relationships}
            evidenceIds={evidenceIds}
            focusedNodeId={focusedNodeId}
            onNodeClick={expandNode}
          />

          {!nodes.length && (
            <div className="graph-empty" aria-hidden="true">
              <svg className="graph-empty-art" viewBox="0 0 240 170">
                <defs>
                  <filter id="ghost-node-glow" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="9" result="blur" />
                    <feFlood floodColor="#61d5ff" floodOpacity=".1" />
                    <feComposite in2="blur" operator="in" />
                    <feMerge>
                      <feMergeNode />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <line x1="62.11" y1="68.68" x2="146.56" y2="48.81" />
                <line x1="175.59" y1="63.16" x2="201.5" y2="120.96" />
                <circle cx="48" cy="72" r="14.5" />
                <circle cx="167" cy="44" r="21" />
                <circle cx="206" cy="131" r="11" />
              </svg>
              <p>질문의 근거가<br />여기에 연결됩니다</p>
            </div>
          )}

          <div className="legend" aria-label="노드 라벨 범례">
            {legendItems.map((item) => (
              <span key={item.label}><i style={{ background: item.color }} />{item.name}</span>
            ))}
          </div>
          <p className="graph-hint">노드에 마우스를 올려 이름 확인 · 클릭해서 이웃 확장</p>
        </section>
      </section>}
      {view === 'ontology' && <OntologyPage />}
      {view === 'schema' && <SchemaMapPage />}
      {view === 'explorer' && <ExplorerPage />}
    </main>
  );
}

function EvidenceList({
  evidence,
  onFocus,
  focusedId,
}: {
  evidence: Evidence;
  onFocus: (nodeId: string) => void;
  focusedId: string | null;
}) {
  return (
    <section className="evidence-section">
      <div className="evidence-title">
        <span className="section-kicker">근거</span>
        <span>선택하면 그래프에서 위치를 찾습니다</span>
      </div>
      <ol>
        {evidence.nodes.map((node, index) => (
          <li key={node.id}>
            <button
              type="button"
              className={focusedId === node.id ? 'active' : ''}
              onClick={() => onFocus(node.id)}
            >
              <span className="citation-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="citation-copy">
                <small><i style={{ background: labelColors[node.label] }} />{node.label}</small>
                <strong>{node.display}</strong>
              </span>
              <span className="focus-arrow" aria-hidden="true">→</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
