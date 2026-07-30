import { check, date, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const project = pgTable("project", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const source = pgTable(
  "source",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    externalKey: text("external_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("source_kind_check", sql`${table.kind} in ('dooray', 'github')`),
    unique("source_kind_external_key_unique").on(table.kind, table.externalKey),
  ],
);

export const conceptDecision = pgTable(
  "concept_decision",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    keyRaw: text("key_raw").notNull(),
    keyNorm: text("key_norm").notNull(),
    kind: text("kind").notNull(),
    canonical: text("canonical"),
    reason: text("reason").notNull(),
    approvedAt: date("approved_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("concept_decision_kind_check", sql`${table.kind} in ('merge_alias', 'block')`),
    check("concept_decision_canonical_check", sql`(${table.kind} = 'merge_alias') = (${table.canonical} is not null)`),
    unique("concept_decision_project_id_key_norm_unique").on(table.projectId, table.keyNorm),
  ],
);
