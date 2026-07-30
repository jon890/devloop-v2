import "reflect-metadata";
import { registerProject, type SourceKind } from "@devloop/registry";
import { type PipelineConfig, withPipelineConfig } from "../config";
import { withRegistryDb } from "./client";
import { optionalFlag, requireFlag } from "./cli";

export interface RegisterProjectOptions {
  code: string;
  name: string;
  sourceKind?: SourceKind;
  sourceKey?: string;
}

export function parseRegisterProjectArgs(args: readonly string[]): RegisterProjectOptions {
  const code = requireFlag(args, "--code");
  const name = requireFlag(args, "--name");
  const sourceKind = optionalFlag(args, "--source-kind");
  const sourceKey = optionalFlag(args, "--source-key");
  if ((sourceKind && !sourceKey) || (!sourceKind && sourceKey)) {
    throw new Error("--source-kind 와 --source-key 는 함께 지정하거나 함께 생략해야 합니다.");
  }
  if (sourceKind && sourceKind !== "dooray" && sourceKind !== "github") {
    throw new Error("--source-kind 는 dooray 또는 github 만 받을 수 있습니다.");
  }
  if (sourceKind && sourceKey) {
    const parsedSourceKind: SourceKind = sourceKind === "github" ? "github" : "dooray";
    return { code, name, sourceKind: parsedSourceKind, sourceKey };
  }
  return { code, name };
}

export async function runRegisterProject(args: readonly string[], config: PipelineConfig): Promise<void> {
  const options = parseRegisterProjectArgs(args);
  await withRegistryDb(config, "register-project", async ({ db, maskedDatabaseUrl }) => {
    const result = await registerProject(db, options);
    console.log(
      JSON.stringify(
        {
          project: result.project.code,
          database: maskedDatabaseUrl,
          status: result.projectCreated ? "registered" : "already_registered",
          source: options.sourceKind
            ? {
                kind: options.sourceKind,
                externalKey: options.sourceKey,
                status: result.sourceCreated ? "registered" : "already_registered",
              }
            : undefined,
        },
        null,
        2,
      ),
    );
  });
}

if (require.main === module) {
  void withPipelineConfig((config) => runRegisterProject(process.argv.slice(2), config)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
