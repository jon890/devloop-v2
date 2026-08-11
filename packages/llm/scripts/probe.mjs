import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmTransport } from "../dist/index.js";

const [model, transportName] = process.argv.slice(2);
if (!model || !["responses", "app-server"].includes(transportName)) {
  console.error("사용법: node packages/llm/scripts/probe.mjs <model> <responses|app-server>");
  process.exitCode = 2;
} else {
  const packageDir = resolve(fileURLToPath(import.meta.url), "../..");
  const repoRoot = resolve(packageDir, "../..");
  const transport = await createLlmTransport({ transport: transportName, cwd: repoRoot });
  try {
    const result = await transport.complete("한 문장으로 오늘 할 일을 정리해 줘.", { model, timeoutMs: 120_000 });
    console.log(`transport=${transportName} model=${model} latencyMs=${result.elapsedMs} response=${result.text.slice(0, 160)}`);
  } finally {
    await transport.close();
  }
}
