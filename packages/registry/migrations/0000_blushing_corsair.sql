CREATE TABLE "concept_decision" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"key_raw" text NOT NULL,
	"key_norm" text NOT NULL,
	"kind" text NOT NULL,
	"canonical" text,
	"reason" text NOT NULL,
	"approved_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_decision_project_id_key_norm_unique" UNIQUE("project_id","key_norm"),
	CONSTRAINT "concept_decision_kind_check" CHECK ("concept_decision"."kind" in ('merge_alias', 'block')),
	CONSTRAINT "concept_decision_canonical_check" CHECK (("concept_decision"."kind" = 'merge_alias') = ("concept_decision"."canonical" is not null))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"external_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_kind_external_key_unique" UNIQUE("kind","external_key"),
	CONSTRAINT "source_kind_check" CHECK ("source"."kind" in ('dooray', 'github'))
);
--> statement-breakpoint
ALTER TABLE "concept_decision" ADD CONSTRAINT "concept_decision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;