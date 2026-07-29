import type { RelationshipType } from "@devloop/shared";

export const RELATIONSHIP_IDENTITY_PROPERTIES: Partial<Record<RelationshipType, string>> = {
  ASSIGNED_TO: "role",
  TAGGED: "dimension",
  RELATES_TO: "kind",
};
