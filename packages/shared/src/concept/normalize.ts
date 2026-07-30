export const CONCEPT_KEY_MERGE_DENYLIST: ReadonlyMap<string, string> = new Map([
  ["analysis", '"/analysis"는 API 경로이고 "analysis"는 일반 코드 참조이므로 서로 다른 개체로 유지한다.'],
  ["cloudtoastcom", '"*.cloud.toast.com"은 와일드카드 도메인이고 "cloud.toast.com"은 개별 호스트이므로 서로 다른 개체로 유지한다.'],
]);

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeConceptKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

export function conceptLookupKeys(value: string): string[] {
  const normalized = normalizeText(value);
  const conceptKey = normalizeConceptKey(value);
  if (!conceptKey || CONCEPT_KEY_MERGE_DENYLIST.has(conceptKey)) {
    return [normalized];
  }
  return [...new Set([normalized, conceptKey])];
}
