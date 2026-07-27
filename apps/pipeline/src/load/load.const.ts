import type { NodeLabel, RelationshipType } from '@devloop/shared';

export const CONCEPT_LABEL: NodeLabel = 'Concept';
export const CONCEPT_KEY_MERGE_DENYLIST: ReadonlyMap<string, string> = new Map([
  [
    'analysis',
    '"/analysis"는 API 경로이고 "analysis"는 일반 코드 참조이므로 서로 다른 개체로 유지한다.',
  ],
  [
    'cloudtoastcom',
    '"*.cloud.toast.com"은 와일드카드 도메인이고 "cloud.toast.com"은 개별 호스트이므로 서로 다른 개체로 유지한다.',
  ],
]);
export const CONCEPT_KEY_CANONICAL_OVERRIDES: ReadonlyMap<string, string> = new Map();
export const RELATIONSHIP_IDENTITY_PROPERTIES: Partial<Record<RelationshipType, string>> = {
  ASSIGNED_TO: 'role',
  TAGGED: 'dimension',
  RELATES_TO: 'kind',
};
