import type { GraphStatsResponse } from "@devloop/shared";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { getGraphStats, useMockApi } from "./api-client";
import { appRoutes, getAppRouteByPathname, type AppRoute } from "./app-route.const";
import { useQueryWorkspace } from "./query/useQueryWorkspace";

function sum(values: Record<string, number> | undefined) {
  return Object.values(values ?? {}).reduce((total, count) => total + count, 0);
}

export type AppOutletContext = {
  workspace: ReturnType<typeof useQueryWorkspace>;
  graphStatsError: string | null;
};

export function App() {
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspace = useQueryWorkspace({ onSubmitStart: () => setError(null) });
  const activeRoute = getAppRouteByPathname(useLocation().pathname);

  useEffect(() => {
    getGraphStats()
      .then(setStats)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "그래프 통계를 불러오지 못했습니다.");
      });
  }, []);

  return (
    <main className="app-shell">
      <AppHeader activeRoute={activeRoute} stats={stats} />
      <Outlet context={{ workspace, graphStatsError: error } satisfies AppOutletContext} />
    </main>
  );
}

function AppHeader({ activeRoute, stats }: { activeRoute: AppRoute; stats: GraphStatsResponse | null }) {
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
            <h1>{activeRoute.title}</h1>
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
        {appRoutes.map((route) => (
          <NavLink key={route.id} to={route.path} end>
            {route.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
