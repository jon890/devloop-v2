export const MEMORY_SCHEMA_VERSION = 1 as const;

export const MEMORY_SOURCE_TYPES = ["dooray-task", "dooray-comment", "dooray-wiki", "git-commit", "git-file"] as const;
export const MEMORY_KINDS = ["decision", "constraint", "incident", "failed-attempt", "lesson"] as const;
export const MEMORY_STATUSES = ["active", "superseded", "deprecated", "historical", "uncertain"] as const;
export const MEMORY_CONFIDENCES = ["high", "medium", "low"] as const;

export const SOURCE_GENERATIONS_DIRECTORY = "source-generations";
export const SOURCE_MANIFEST_FILE = "source-manifest.json";
export const EVIDENCE_FILE = "evidence.jsonl";
export const CURRENT_SOURCE_POINTER_FILE = "current-source.json";
