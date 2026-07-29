import { Navigate, Route, Routes, useOutletContext } from "react-router";
import { App, type AppOutletContext } from "./App";
import { appRoutes, defaultAppRoute, type ViewId } from "./app-route.const";
import { ExplorerPage } from "./ExplorerPage";
import { OntologyPage } from "./OntologyPage";
import { QueryWorkspace } from "./query/QueryWorkspace";
import { SchemaMapPage } from "./SchemaMapPage";

const pageByView: Record<ViewId, React.ReactNode> = {
  query: <QueryRoute />,
  ontology: <OntologyPage />,
  schema: <SchemaMapPage />,
  explorer: <ExplorerPage />,
};

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<App />}>
        {appRoutes.map((route) => (
          <Route key={route.id} path={route.path} element={pageByView[route.id]} />
        ))}
        <Route path="/" element={<Navigate to={defaultAppRoute.path} replace />} />
        <Route path="*" element={<Navigate to={defaultAppRoute.path} replace />} />
      </Route>
    </Routes>
  );
}

function QueryRoute() {
  const { workspace, graphStatsError } = useOutletContext<AppOutletContext>();

  return <QueryWorkspace workspace={workspace} graphStatsError={graphStatsError} />;
}
