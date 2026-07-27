import type { OntologyResponse } from '@devloop/shared';
import { useEffect, useState } from 'react';
import { getOntology } from './api-client';
import { labelColors } from './GraphCanvas';
import { SchemaCanvas } from './SchemaCanvas';

export function OntologyPage() {
  const [ontology, setOntology] = useState<OntologyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOntology().then(setOntology).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : '온톨로지 계약을 불러오지 못했습니다.');
    });
  }, []);

  return (
    <section className="ontology-page page-surface">
      <div className="document-hero">
        <div className="page-heading">
          <span className="section-kicker">온톨로지 정의</span>
          <h2>이 시스템이 지식을 나누고 연결하는 규칙</h2>
          <p>
            실제 데이터보다 먼저 존재하는 계약입니다. 각 노드는 무엇을 뜻하고,
            어떤 키로 식별되며, 관계는 어느 방향으로 이어지는지 설명합니다.
          </p>
        </div>
        <div className="contract-summary" aria-label="온톨로지 계약 규모">
          <span><strong>{ontology?.nodes.length ?? '—'}</strong>노드 라벨</span>
          <span><strong>{ontology?.relationships.length ?? '—'}</strong>관계 유형</span>
          <small>코드 계약에서 실시간 제공</small>
        </div>
      </div>

      {error && <div className="error-message page-error" role="alert">{error}</div>}
      {!ontology && !error && <div className="page-loading">온톨로지 계약을 읽는 중입니다.</div>}

      {ontology && (
        <div className="ontology-document">
          <section className="ontology-diagram-section" aria-labelledby="ontology-diagram-title">
            <div className="ontology-diagram-heading">
              <div>
                <span className="section-kicker">계약 관계 도식</span>
                <h3 id="ontology-diagram-title">{ontology.nodes.length}개 라벨을 잇는 {ontology.relationships.length}개 관계</h3>
              </div>
              <p>관계 이름과 화살표 방향이 코드 계약의 연결 규칙을 나타냅니다.</p>
            </div>
            <SchemaCanvas ontology={ontology} variant="contract" />
          </section>

          <section className="definition-section">
            <div className="definition-heading">
              <div><span>노드 계약</span><h3>지식을 구성하는 {ontology.nodes.length}가지 단위</h3></div>
              <p>색은 모든 그래프 화면에서 동일한 라벨을 가리킵니다.</p>
            </div>
            <div className="node-definition-grid">
              {ontology.nodes.map((definition) => (
                <article key={definition.label} className="node-definition-card">
                  <div className="definition-label">
                    <i style={{ background: labelColors[definition.label] }} />
                    <strong>{definition.label}</strong>
                  </div>
                  <p>{definition.description}</p>
                  <dl>
                    <div><dt>식별 키</dt><dd>{definition.key}</dd></div>
                    <div>
                      <dt>주요 속성</dt>
                      <dd>{definition.properties.filter((property) => property !== definition.key).join(' · ')}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <section className="definition-section relationship-section">
            <div className="definition-heading">
              <div><span>관계 계약</span><h3>맥락을 만드는 {ontology.relationships.length}가지 방향</h3></div>
              <p>화살표의 왼쪽이 시작 라벨, 오른쪽이 도착 라벨입니다.</p>
            </div>
            <div className="relationship-table" role="table" aria-label="온톨로지 관계 정의">
              <div className="relationship-row table-head" role="row">
                <span role="columnheader">관계</span>
                <span role="columnheader">방향</span>
                <span role="columnheader">의미</span>
              </div>
              {ontology.relationships.map((definition) => (
                <div className="relationship-row" role="row" key={definition.type}>
                  <strong role="cell">{definition.type}</strong>
                  <div role="cell" className="direction-list">
                    {definition.directions.map((direction) => (
                      <span key={`${direction.from}-${direction.to}`}>
                        <i style={{ background: labelColors[direction.from] }} />
                        {direction.from}
                        <b aria-hidden="true">→</b>
                        <i style={{ background: labelColors[direction.to] }} />
                        {direction.to}
                      </span>
                    ))}
                  </div>
                  <p role="cell">
                    {definition.description}
                    {definition.properties?.length
                      ? <small>관계 속성 · {definition.properties.join(', ')}</small>
                      : null}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
