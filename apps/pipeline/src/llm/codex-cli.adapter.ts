import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LlmOptionsSchema, type LlmCli, type LlmOptions, type LlmResult } from "./llm-cli";
import { runCliProcess } from "./cli-process";

export class CodexCliAdapter implements LlmCli {
  async complete(prompt: string, opts?: LlmOptions): Promise<LlmResult> {
    const parsedOptions = LlmOptionsSchema.parse(opts ?? {});
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "devloop-codex-"));
    const outputPath = path.join(tempDirectory, "last-message.json");
    const startedAt = performance.now();
    try {
      await runCliProcess("codex", buildCodexArgs(outputPath, prompt, parsedOptions), { timeoutMs: parsedOptions.timeoutMs });
      const text = await readFile(outputPath, "utf8");
      return { text, elapsedMs: performance.now() - startedAt };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export function buildCodexArgs(outputPath: string, prompt: string, opts: LlmOptions = {}): string[] {
  const parsedOptions = LlmOptionsSchema.parse(opts);
  if (!parsedOptions.model) {
    throw new Error("CodexCliAdapter requires opts.model or LLM_MODEL.");
  }
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-last-message",
    outputPath,
    "-m",
    parsedOptions.model,
    ...(parsedOptions.effort ? ["-c", `model_reasoning_effort=${parsedOptions.effort}`] : []),
    prompt,
  ];
}
