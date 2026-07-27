import type { Evidence } from '@devloop/shared';
import { labelColors } from '../GraphCanvas';

export function EvidenceList({
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
