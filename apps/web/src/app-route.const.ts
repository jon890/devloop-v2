export const appRoutes = [
  {
    id: "query",
    path: "/query",
    label: "질의응답",
    title: "결정의 맥락을 따라가세요",
  },
  {
    id: "ontology",
    path: "/ontology",
    label: "온톨로지 정의",
    title: "지식의 계약을 읽습니다",
  },
  {
    id: "schema",
    path: "/schema",
    label: "스키마 맵",
    title: "구조와 규모를 함께 봅니다",
  },
  {
    id: "explorer",
    path: "/explorer",
    label: "인스턴스 탐색",
    title: "연결을 한 단계씩 펼칩니다",
  },
] as const;

export type AppRoute = (typeof appRoutes)[number];
export type ViewId = AppRoute["id"];

export const defaultAppRoute = appRoutes[0];

export function getAppRouteByPathname(pathname: string): AppRoute {
  return appRoutes.find((route) => route.path === pathname) ?? defaultAppRoute;
}
