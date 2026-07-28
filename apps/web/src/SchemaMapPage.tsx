import type { GraphSamplesResponse, GraphStatsResponse, OntologyResponse } from "@devloop/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGraphSamples, getGraphStats, getOntology } from "./api-client";
import { labelColors } from "./GraphCanvas";
import { SchemaCanvas, type SchemaSelection } from "./SchemaCanvas";

function sum(values: Record<string, number> | undefined) {
  return Object.values(values ?? {}).reduce((total, count) => total + count, 0);
}

export function SchemaMapPage() {
  const [ontology, setOntology] = useState<OntologyResponse | null>(null);
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [selection, setSelection] = useState<SchemaSelection>({
    kind: "label",
    value: "Project",
  });
  const [samples, setSamples] = useState<GraphSamplesResponse>({ nodes: [], relationships: [] });
  const [loading, setLoading] = useState(true);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sampleRequestId = useRef(0);

  const loadSamples = useCallback(async (nextSelection: SchemaSelection) => {
    const requestId = sampleRequestId.current + 1;
    sampleRequestId.current = requestId;
    setSelection(nextSelection);
    setSampleLoading(true);
    setError(null);
    try {
      const response = await getGraphSamples(nextSelection.kind, nextSelection.value);
      if (sampleRequestId.current === requestId) setSamples(response);
    } catch (cause) {
      if (sampleRequestId.current === requestId) {
        setError(cause instanceof Error ? cause.message : "인스턴스 샘플을 불러오지 못했습니다.");
        setSamples({ nodes: [], relationships: [] });
      }
    } finally {
      if (sampleRequestId.current === requestId) setSampleLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([getOntology(), getGraphStats()])
      .then(([ontologyResponse, statsResponse]) => {
        setOntology(ontologyResponse);
        setStats(statsResponse);
        return loadSamples({ kind: "label", value: "Project" });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "스키마 맵을 불러오지 못했습니다.");
      })
      .finally(() => setLoading(false));
  }, [loadSamples]);

  const selectedDefinition = useMemo(() => {
    if (!ontology) return null;
    return selection.kind === "label"
      ? ontology.nodes.find((definition) => definition.label === selection.value)
      : ontology.relationships.find((definition) => definition.type === selection.value);
  }, [ontology, selection]);

  return (
    <section className="schema-map-page page-surface">
      <div className="map-heading">
        <div className="page-heading compact">
          <span className="section-kicker">스키마 맵</span>
          <h2>계약의 구조와 운영 데이터의 규모를 함께 봅니다</h2>
          <p>라벨은 노드 수를, 관계 목록은 실제 연결 수를 표시합니다. 타입을 선택하면 운영 그래프의 샘플을 읽습니다.</p>
        </div>
        <div className="map-totals">
          <span>
            <strong>{stats ? sum(stats.nodes).toLocaleString("ko-KR") : "—"}</strong>전체 노드
          </span>
          <span>
            <strong>{stats ? sum(stats.relationships).toLocaleString("ko-KR") : "—"}</strong>전체 관계
          </span>
        </div>
      </div>

      {error && (
        <div className="error-message page-error" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="page-loading dark">운영 그래프의 구조와 수치를 읽는 중입니다.</div>}

      {ontology && stats && (
        <>
          <div className="schema-workspace">
            <section className="schema-diagram-panel">
              <div className="diagram-toolbar">
                <span>구조 다이어그램</span>
                <small>노드·관계 클릭으로 실제 샘플 확인</small>
              </div>
              <SchemaCanvas ontology={ontology} stats={stats} onSelect={loadSamples} />
            </section>

            <aside className="schema-sample-panel">
              <div className="sample-heading">
                <span>{selection.kind === "label" ? "노드 라벨" : "관계 유형"}</span>
                <h3>{selection.value}</h3>
                <p>{selectedDefinition?.description}</p>
              </div>

              <div className="sample-list" aria-live="polite">
                <div className="sample-list-heading">
                  <span>운영 데이터 샘플</span>
                  <small>최대 5개</small>
                </div>
                {sampleLoading && <div className="sample-empty">샘플을 읽는 중입니다.</div>}
                {!sampleLoading && selection.kind === "label" && samples.nodes.length > 0 && (
                  <ul>
                    {samples.nodes.map((node) => (
                      <li key={node.id}>
                        <i style={{ background: labelColors[node.label] }} />
                        <span>
                          <strong>{node.display}</strong>
                          <small>{node.key}</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {!sampleLoading && selection.kind === "relationship" && samples.relationships.length > 0 && (
                  <ul className="relationship-samples">
                    {samples.relationships.map((relationship) => {
                      const start = samples.nodes.find((node) => node.id === relationship.startId);
                      const end = samples.nodes.find((node) => node.id === relationship.endId);
                      return (
                        <li key={relationship.id}>
                          <span>
                            <strong>{start?.display ?? relationship.startId}</strong>
                            <small>{start?.label}</small>
                          </span>
                          <b aria-hidden="true">→</b>
                          <span>
                            <strong>{end?.display ?? relationship.endId}</strong>
                            <small>{end?.label}</small>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!sampleLoading &&
                  ((selection.kind === "label" && !samples.nodes.length) || (selection.kind === "relationship" && !samples.relationships.length)) && (
                    <div className="sample-empty">이 타입의 운영 데이터 샘플이 없습니다.</div>
                  )}
              </div>
            </aside>
          </div>

          <div className="schema-type-index">
            <section>
              <div className="type-index-heading">
                <span>노드 라벨</span>
                <small>{ontology.nodes.length}종</small>
              </div>
              <div className="type-buttons node-types">
                {ontology.nodes.map((definition) => (
                  <button
                    type="button"
                    key={definition.label}
                    className={selection.kind === "label" && selection.value === definition.label ? "active" : ""}
                    onClick={() => loadSamples({ kind: "label", value: definition.label })}
                  >
                    <i style={{ background: labelColors[definition.label] }} />
                    <span>{definition.label}</span>
                    <strong>{(stats.nodes[definition.label] ?? 0).toLocaleString("ko-KR")}</strong>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="type-index-heading">
                <span>관계 유형</span>
                <small>{ontology.relationships.length}종</small>
              </div>
              <div className="type-buttons relationship-types">
                {ontology.relationships.map((definition) => (
                  <button
                    type="button"
                    key={definition.type}
                    className={selection.kind === "relationship" && selection.value === definition.type ? "active" : ""}
                    onClick={() => loadSamples({ kind: "relationship", value: definition.type })}
                  >
                    <span>{definition.type}</span>
                    <strong>{(stats.relationships[definition.type] ?? 0).toLocaleString("ko-KR")}</strong>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
