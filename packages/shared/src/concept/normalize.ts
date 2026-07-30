export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeConceptKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

export function conceptLookupKeys(value: string, blockedConceptKeys: ReadonlySet<string> = new Set()): string[] {
  const normalized = normalizeText(value);
  const conceptKey = normalizeConceptKey(value);
  if (!conceptKey || blockedConceptKeys.has(conceptKey)) {
    return [normalized];
  }
  return [...new Set([normalized, conceptKey])];
}
