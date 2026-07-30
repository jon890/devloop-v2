import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { CurationSchema, MissingProjectError, previewCurationWrite, replaceCuration, upsertCuration } from "@devloop/registry";
import { type PipelineConfig, withPipelineConfig } from "../config";
import { withRegistryDb } from "./client";
import { hasFlag, requireAbsolutePath, requireFlag } from "./cli";

export interface ImportCurationOptions {
  project: string;
  file: string;
  replace: boolean;
  dryRun: boolean;
}

export function parseImportCurationArgs(args: readonly string[]): ImportCurationOptions {
  return {
    project: requireFlag(args, "--project"),
    file: requireAbsolutePath(requireFlag(args, "--file"), "--file"),
    replace: hasFlag(args, "--replace"),
    dryRun: hasFlag(args, "--dry-run"),
  };
}

export async function runImportCuration(args: readonly string[], config: PipelineConfig): Promise<void> {
  const options = parseImportCurationArgs(args);
  const input = CurationSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
  await withRegistryDb(config, "import-curation", async ({ db }) => {
    try {
      const result = options.dryRun
        ? await previewCurationWrite(db, options.project, input, options.replace ? "replace" : "upsert")
        : options.replace
          ? await replaceCuration(db, options.project, input)
          : await upsertCuration(db, options.project, input);
      console.log(JSON.stringify({ ...result, dryRun: options.dryRun }, null, 2));
    } catch (error) {
      if (error instanceof MissingProjectError) {
        console.error(
          JSON.stringify(
            {
              error: error.message,
              project: error.project,
              registeredProjects: error.registeredProjects.map((project) => project.code),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });
}

if (require.main === module) {
  void withPipelineConfig((config) => runImportCuration(process.argv.slice(2), config)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
