import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const START = "<!-- MEMORY-SEARCH-VOLUNTARY-POLICY:START -->";
const END = "<!-- MEMORY-SEARCH-VOLUNTARY-POLICY:END -->";

function policyBlock(fileName: string): string {
  const text = readFileSync(path.resolve(__dirname, "../../../..", fileName), "utf8");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  assert.notEqual(start, -1, `${fileName} missing policy start marker`);
  assert.notEqual(end, -1, `${fileName} missing policy end marker`);
  return text.slice(start, end + END.length);
}

describe("Experience Memory voluntary policy", () => {
  it("keeps AGENTS.md and CLAUDE.md policy blocks byte-identical", () => {
    const agents = policyBlock("AGENTS.md");
    const claude = policyBlock("CLAUDE.md");
    assert.equal(agents, claude);
    assert.match(agents, /pnpm --silent memory-search -- --query <query> --project tc-ocr --allow-incomplete/);
    assert.match(agents, /historical decisions, compatibility constraints, incidents, migrations, or legacy behavior/);
    assert.match(agents, /clear code-only edits/);
    assert.match(agents, /low confidence, `uncertain` status, or conflicting sources/);
    assert.match(agents, /Current source code, current tests, and explicit task instructions win/);
  });
});
