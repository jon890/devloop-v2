import type { Evidence, GraphNode, GraphRel, GraphStatsResponse, QueryResponse } from '@devloop/shared';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { getGraphStats, getNeighbors, queryGraph, useMockApi } from './api-client';
import { GraphCanvas, labelColors, legendItems } from './GraphCanvas';

const initialQuestion = '모델 서버 배포 전략은 어떻게 결정됐고, 확인할 위험은 무엇인가요?';

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return Array.from(new Map([...current, ...incoming].map((item) => [item.id, item])).values());
}

function sum(values: Record<string, number> | undefined) {
  return Object.values(values ?? {}).reduce((total, count) => total + count, 0);
}

export function App() {
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
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <p className="eyebrow">Dooray knowledge map</p>
            <h1>결정의 맥락을 따라가세요</h1>
          </div>
        </div>
        <div className="stats" aria-label="전체 그래프 규모">
          <div><strong>{stats ? sum(stats.nodes).toLocaleString('ko-KR') : '—'}</strong><span>노드</span></div>
          <span className="stats-divider" />
          <div><strong>{stats ? sum(stats.relationships).toLocaleString('ko-KR') : '—'}</strong><span>관계</span></div>
          <span className={`mode-badge ${useMockApi ? 'mock' : ''}`}>{useMockApi ? 'MOCK' : 'LIVE API'}</span>
        </div>
      </header>

      <section className="workspace">
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
              <span className="ghost-node one" /><span className="ghost-node two" />
              <span className="ghost-node three" /><span className="ghost-line a" />
              <span className="ghost-line b" />
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
      </section>
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
