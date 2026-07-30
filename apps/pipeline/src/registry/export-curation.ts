import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { readCuration, MissingProjectError } from "@devloop/registry";
import { type PipelineConfig, withPipelineConfig } from "../config";
import { withRegistryDb } from "./client";
import { requireAbsolutePath, requireFlag } from "./cli";

export interface ExportCurationOptions {
  project: string;
  out: string;
}

export function parseExportCurationArgs(args: readonly string[]): ExportCurationOptions {
  return {
    project: requireFlag(args, "--project"),
    out: requireAbsolutePath(requireFlag(args, "--out"), "--out"),
  };
}

export async function runExportCuration(args: readonly string[], config: PipelineConfig): Promise<void> {
  const options = parseExportCurationArgs(args);
  await withRegistryDb(config, "export-curation", async ({ db }) => {
    try {
      const curation = await readCuration(db, options.project);
      await writeFile(options.out, `${JSON.stringify(curation, null, 2)}\n`, "utf8");
      console.log(
        JSON.stringify({ project: options.project, out: options.out, merges: curation.merges.length, blocks: curation.blocks.length }, null, 2),
      );
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
  void withPipelineConfig((config) => runExportCuration(process.argv.slice(2), config)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
