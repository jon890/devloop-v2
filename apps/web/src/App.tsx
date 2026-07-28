import type { GraphStatsResponse } from "@devloop/shared";
import { useEffect, useState } from "react";
import { getGraphStats, useMockApi } from "./api-client";
import { ExplorerPage } from "./ExplorerPage";
import { OntologyPage } from "./OntologyPage";
import { QueryWorkspace } from "./query/QueryWorkspace";
import { useQueryWorkspace } from "./query/useQueryWorkspace";
import { SchemaMapPage } from "./SchemaMapPage";

type ViewId = "query" | "ontology" | "schema" | "explorer";

const views: { id: ViewId; label: string }[] = [
  { id: "query", label: "질의응답" },
  { id: "ontology", label: "온톨로지 정의" },
  { id: "schema", label: "스키마 맵" },
  { id: "explorer", label: "인스턴스 탐색" },
];

const viewTitles: Record<ViewId, string> = {
  query: "결정의 맥락을 따라가세요",
  ontology: "지식의 계약을 읽습니다",
  schema: "구조와 규모를 함께 봅니다",
  explorer: "연결을 한 단계씩 펼칩니다",
};

function sum(values: Record<string, number> | undefined) {
  return Object.values(values ?? {}).reduce((total, count) => total + count, 0);
}

export function App() {
  const [view, setView] = useState<ViewId>("query");
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspace = useQueryWorkspace({ onSubmitStart: () => setError(null) });

  useEffect(() => {
    getGraphStats()
      .then(setStats)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "그래프 통계를 불러오지 못했습니다.");
      });
  }, []);

  return (
    <main className="app-shell">
      <AppHeader view={view} stats={stats} onViewChange={setView} />
      {view === "query" && <QueryWorkspace workspace={workspace} graphStatsError={error} />}
      {view === "ontology" && <OntologyPage />}
      {view === "schema" && <SchemaMapPage />}
      {view === "explorer" && <ExplorerPage />}
    </main>
  );
}

function AppHeader({ view, stats, onViewChange }: { view: ViewId; stats: GraphStatsResponse | null; onViewChange: (view: ViewId) => void }) {
  return (
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
          <div>
            <strong>{stats ? sum(stats.nodes).toLocaleString("ko-KR") : "—"}</strong>
            <span>노드</span>
          </div>
          <span className="stats-divider" />
          <div>
            <strong>{stats ? sum(stats.relationships).toLocaleString("ko-KR") : "—"}</strong>
            <span>관계</span>
          </div>
          <span className={`mode-badge ${useMockApi ? "mock" : ""}`}>{useMockApi ? "MOCK" : "LIVE API"}</span>
        </div>
      </div>
      <nav className="main-nav" aria-label="그래프 화면">
        {views.map((item) => (
          <button
            type="button"
            key={item.id}
            className={view === item.id ? "active" : ""}
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onViewChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
