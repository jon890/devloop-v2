import { GraphCanvas, legendItems } from '../GraphCanvas';
import { EvidenceList } from './EvidenceList';
import type { useQueryWorkspace } from './useQueryWorkspace';

export function QueryWorkspace({
  workspace,
  graphStatsError,
}: {
  workspace: ReturnType<typeof useQueryWorkspace>;
  graphStatsError: string | null;
}) {
  return (
    <section className="workspace">
      <aside className="chat-panel">
        <div className="panel-intro">
          <span className="section-kicker">질문</span>
          <p>업무, 결정, 담당자 사이의 연결을 자연어로 탐색합니다.</p>
        </div>

        <form className="question-form" onSubmit={workspace.submitQuestion}>
          <label htmlFor="question">무엇을 확인할까요?</label>
          <textarea
            id="question"
            value={workspace.question}
            onChange={(event) => workspace.setQuestion(event.target.value)}
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
            <button type="submit" disabled={workspace.loading || !workspace.question.trim()}>
              {workspace.loading ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">↗</span>}
              {workspace.loading ? '근거 찾는 중' : '질문하기'}
            </button>
          </div>
        </form>

        {(workspace.error || graphStatsError) && <div className="error-message" role="alert">{workspace.error ?? graphStatsError}</div>}

        <div className={`answer-stack ${workspace.result ? 'has-result' : ''}`} aria-live="polite">
          {!workspace.result && !workspace.loading && (
            <div className="empty-answer">
              <div className="empty-orbit" aria-hidden="true"><span /></div>
              <h2>답과 근거를 한 화면에서</h2>
              <p>질문하면 관련 결정과 업무를 추려 오른쪽 그래프에 표시합니다.</p>
            </div>
          )}

          {workspace.loading && (
            <div className="answer-skeleton" aria-label="답변을 만드는 중">
              <span /><span /><span />
            </div>
          )}

          {workspace.result && !workspace.loading && (
            <>
              <article className="answer-card">
                <div className="answer-heading">
                  <span className="section-kicker">답변</span>
                  <span className="grounded-badge">근거 {workspace.result.evidence.nodes.length}개</span>
                </div>
                <p>{workspace.result.answer}</p>
              </article>

              <EvidenceList evidence={workspace.result.evidence} onFocus={workspace.focusEvidence} focusedId={workspace.focusedNodeId} />

              <details className="cypher-disclosure">
                <summary><span>생성된 Cypher</span><small>질의 검증용</small></summary>
                <pre><code>{workspace.result.cypher}</code></pre>
              </details>
            </>
          )}
        </div>
      </aside>

      <section className="graph-panel">
        <div className="graph-toolbar">
          <div>
            <span className="section-kicker light">근거 그래프</span>
            <p>{workspace.nodes.length ? `${workspace.nodes.length}개 노드 · ${workspace.relationships.length}개 관계` : '질문을 입력하면 그래프가 구성됩니다.'}</p>
          </div>
          {workspace.expandingId && <span className="expansion-status"><span className="spinner" /> 이웃 확장 중</span>}
        </div>

        <GraphCanvas
          nodes={workspace.nodes}
          relationships={workspace.relationships}
          evidenceIds={workspace.evidenceIds}
          focusedNodeId={workspace.focusedNodeId}
          onNodeClick={workspace.expandNode}
        />

        {!workspace.nodes.length && (
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
    </section>
  );
}
