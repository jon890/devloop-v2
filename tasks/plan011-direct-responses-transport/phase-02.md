# Phase 02 — 추론 강도를 설정으로 못 박고 두 전송에 같은 값을 싣는다

**Execution profile**: standard
**Status**: completed

---

## 목표

**지금 추론 강도가 미지정이다.** `.env` 에 `LLM_REASONING_EFFORT` 가 없어 API 는 강도를 넘기지
않고, **전송마다 자기 기본값을 쓴다.**

| 전송 | 강도를 안 넘길 때 |
| --- | --- |
| 상주 `app-server` | `~/.codex/config.toml` 의 `model_reasoning_effort = "high"` 를 볼 가능성이 있다 |
| Responses 직접 호출 | 서버 기본값을 쓴다 |

그 상태로 Phase 03 이 전송을 바꾸면 **지연·품질 변화가 전송 덕인지 강도 덕인지 가를 수 없다.**
모델을 지정하지 않아 조용히 기본 모델로 돌던 사고가 [ADR 0003](../../docs/adr/0003-fail-fast-config.md)
을 낳았고 이건 같은 성격이다.

이 phase 는 **강도를 명시로 만들어 다음 phase 의 측정이 정직해지게 한다.**

**이 phase 는 Phase 01 이 만드는 직접 전송을 전제한다.**

**범위 외**

- 기본 전송 변경 — Phase 03
- **호출별 강도 분리 — 하지 않는다.** 앵커 추출에 `high` 가 필요한지는 확인되지 않았고,
  실측이 `low` 5.8초 대 `high` 9.8초였으나 각 1회라 근거가 약하다. 별개 지레이고 ADR 0009 가
  후속으로 기록해 두었다
- 파이프라인 추출 강도 — 조율자 판단으로 범위에서 뺐다. 강도를 명시하면 `gpt-5.5@default`
  캐시 537건이 전부 빗나가므로 의도적으로 미지정을 유지한다

---

## 작업 항목 (3)

### 1. 지금 무엇이 실제로 실리는지 먼저 확인한다

**추측으로 값을 고르지 마라.** 위 표의 상주 전송 쪽은 "가능성이 있다" 이고 확인되지 않았다.

상주 전송으로 호출을 한 번 보내고 서버 로그·응답에서 어떤 강도가 적용됐는지 확인한다.
확인이 안 되면 **확인 못 했다고 phase 결과에 적고**, 아래 2번의 명시 값을 그대로 쓴다.

이걸 먼저 하는 이유 — 지금 값을 모르면 **명시로 바꾸는 순간 품질이 바뀌었는지도 모른다.**

### 2. 설정에 강도를 명시한다

`apps/api/src/config/api-config.const.ts` 의 `LLM_REASONING_EFFORTS` 는 지금
`["minimal", "low", "medium", "high"]` 다.

- **엔드포인트가 받는 값은 더 넓다.** 실측으로 확인한 지원 값은
  `none`·`minimal`·`low`·`medium`·`high`·`xhigh`·`max` 이고, 엉뚱한 값에 400 과 함께
  지원 목록을 돌려준다
- 열거형을 넓힐지는 **필요할 때만 한다.** 이번에 쓰지 않는 값을 미리 넣지 마라
- **기본값을 코드에 둔다.** `.env` 에만 두면 그 파일이 없는 환경에서 다시 미지정으로 돌아간다
- 값이 무엇이어야 하는지는 1번의 확인 결과를 따른다. 확인이 안 됐으면 `high` 를 쓴다 —
  `~/.codex/config.toml` 이 그 값이고, 지금 품질을 만든 값일 가능성이 가장 높다

### 3. 두 전송이 그 값을 같게 싣는다

- 직접 호출은 `reasoning.effort` 로 싣는다
- 상주 전송은 `turn/start` 의 `effort` 로 싣는다
- **어느 쪽도 강도 없이 호출되는 경로를 남기지 마라.** 남기면 이 phase 가 한 일이 없어진다

파이프라인도 같은 규칙을 따른다. 단 **추출 캐시 키를 건드리지 않는지 확인한다** —
캐시 디렉터리가 `<모델>@<강도>` 형태(`gpt-5.5@default` 등)라면 강도를 명시하는 것만으로
캐시가 빗나갈 수 있다. **빗나가면 537건 재추출이다.** 확인하고, 빗나간다면 진행하지 말고
결과에 적어 보고한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/api/src/config/api-config.const.ts` | 수정 — 기본 강도 |
| `apps/api/src/config/api-config.schema.ts` | 수정 |
| `apps/api/src/query/query.service.ts` | 수정 — 호출에 강도를 싣는다 |
| `apps/pipeline/src/config/*` | 수정 — 같은 규칙 |
| `packages/llm/src/*` | 수정 — 두 전송이 강도를 싣는다 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter @devloop/llm test
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

강도 없이 호출되는 경로가 남았는지 센다.

```bash
# cwd: 저장소 루트
grep -rn "effort" packages/llm/src apps/api/src/query apps/pipeline/src/infer --include='*.ts' | grep -v test
```

추출 캐시가 살아 있는지 센다. **변경 전후 파일 수가 같아야 한다.**

```bash
# cwd: 저장소 루트
find apps/pipeline/data/cache -type f | wc -l
```

새 테스트가 덮어야 할 것이다.

- 설정에 강도가 없어도 기본값이 실린다
- 직접 호출 요청에 `reasoning.effort` 가 실린다
- 상주 전송의 `turn/start` 에 `effort` 가 실린다
- 허용 목록 밖 값은 기동 시 거부된다

## 의도 메모 (왜)

- **명시를 먼저 하는 이유** — 전송을 바꾸는 변경과 강도가 바뀌는 변경이 겹치면 원인을 못 가른다.
  `plan008` 에서 두 지레를 함께 당겨 개선분의 원인을 잘못 이해한 사건이 있었다
- **지금 값을 먼저 확인하는 이유** — 명시 값을 잘못 고르면 이 phase 가 조용히 품질을 바꾼다.
  그러면 Phase 04 가 재는 것이 전송 효과가 아니게 된다
- **열거형을 미리 넓히지 않는 이유** — 쓰지 않는 값을 허용하면 설정 실수의 여지만 늘어난다
