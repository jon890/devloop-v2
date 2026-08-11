type JsonPrimitive = boolean | number | string | null;
export type CanonicalJsonValue = JsonPrimitive | CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue };

function canonicalize(value: CanonicalJsonValue): CanonicalJsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

/** Object key만 정렬하고 의미가 있는 array 순서는 그대로 보존한다. */
export function canonicalJson(value: CanonicalJsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function sourceRefKey(ref: { readonly sourceType: string; readonly sourceId: string }): string {
  return `${ref.sourceType}:${ref.sourceId}`;
}
