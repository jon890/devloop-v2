# Phase 02 — 두 Agent의 voluntary policy와 실행 계측을 연결한다

**Execution profile**: deep
**Status**: pending

---

## 목표

Claude Code와 Codex가 같은 `memory-search` 명령·trigger·skip·원문 재확인 계약을 사용하고, 평가 runner가 Agent별 event를 같은 telemetry로 정규화하게 한다.

**범위 외**: automatic retrieval, 모든 prompt hook, Agent별 storage API, #9 전체 반복 실행.

---

## 작업 항목 (5)

### 1. 단일 검색 명령을 root에 노출한다

root `package.json`에 기존 pipeline 명령을 호출하는 `memory-search` script를 추가한다.
응답은 기존 JSON 하나이며 model·provider·effort override를 새로 노출하지 않는다.

### 2. 두 Agent 문서의 policy를 동등하게 유지한다

`AGENTS.md`와 `CLAUDE.md`에 같은 marker 구간을 둔다.
과거 결정·호환성·장애·migration·legacy에서는 검색하고 명확한 code-only 변경에서는 생략한다.
low confidence, `uncertain`, source 충돌은 원문 확인이 필요하며 Memory가 current source보다 우선하지 않는다고 적는다.

### 3. Agent process adapter를 분리한다

`.claude/skills/kg-eval/scripts/memory/agent-runner.mjs`는 공통 timeout·종료·stdout/stderr 경계를 가진다.
Codex adapter는 `codex exec --json`, Claude adapter는 `claude -p --output-format stream-json`을 사용하되 shell command 문자열 조립이 아니라 argv 배열로 실행한다.
조건 간 model·effort·권한 인자가 달라지면 run을 거부한다.

### 4. event telemetry를 정규화한다

`.claude/skills/kg-eval/scripts/memory/telemetry.mjs`는 turns, toolCalls, sourceReads, memoryCalls, graphCalls, inputTokens, outputTokens, reworkCount를 계산한다.
Agent가 usage를 제공하지 않으면 token은 `null`이며 문자 수로 대체하지 않는다.
Memory call은 실제 `memory-search` command event로만 센다.
Codex fixture는 `item.completed`의 `command_execution`과 `turn.completed.usage`를,
Claude fixture는 `assistant.message.content[].tool_use`와 `result.usage`를 고정한다.

### 5. 조건 입력과 회귀 테스트를 구현한다

`.claude/skills/kg-eval/scripts/memory/condition.mjs`는 `no-memory`, `agent-triggered`, `oracle-memory` 입력을 만든다.
세 조건의 task prompt·revision·validation은 동일하고 제공되는 Memory 정보만 달라야 한다.
fixture JSONL로 Codex·Claude parser, code-only skip, uncertain source 확인 지시, timeout을 검증한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `package.json` | root `memory-search` script 추가 |
| `AGENTS.md` | 공통 voluntary policy 추가 |
| `CLAUDE.md` | 공통 voluntary policy 추가 |
| `.claude/skills/kg-eval/scripts/memory/agent-runner.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/telemetry.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/condition.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/memory-agent.test.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/fixtures/memory/codex-command.jsonl` | Codex command·usage fixture 신규 |
| `.claude/skills/kg-eval/tests/fixtures/memory/claude-command.jsonl` | Claude tool_use·usage fixture 신규 |
| `.claude/skills/kg-eval/tests/fixtures/memory/usage-missing.jsonl` | token `null` fixture 신규 |
| `apps/pipeline/src/memory/agent-policy.test.ts` | 두 marker 동등성 검사 신규 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-agent.test.mjs
pnpm --filter pipeline test
pnpm --silent memory-search -- --query fail-fast --project tc-ocr --allow-incomplete
git diff --check
```

pipeline 전체 실행 건수가 plan012의 216건보다 늘고 실패 0건이어야 한다.
smoke stdout은 JSON 하나여야 한다.

## 의도 메모 (왜)

- Agent별 검색 adapter를 만들지 않는 이유는 같은 검색 계약을 직접 검증하기 위해서다.
- telemetry를 CLI에 넣지 않는 이유는 production 검색과 평가 계측의 책임을 섞지 않기 위해서다.
- 자동 hook을 만들지 않는 이유는 voluntary 기준선이 #12의 선행 조건이기 때문이다.

## Blocked 조건

- Codex 또는 Claude CLI의 event 형식을 fixture로 고정할 수 없으면 `PHASE_BLOCKED: Agent event 계약 불명`으로 종료한다.
