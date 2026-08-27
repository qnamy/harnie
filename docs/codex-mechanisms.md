# Spike — 메커니즘 확정 기록 (재현 가능)

harnie 구현이 의존하는 외부 메커니즘의 **확정 사실**. codex 쪽은 리포의 probe로 재현, 플러그인 쪽은 Claude Code 공식 문서(2.1.207+) 근거.

## Codex MCP (`codex mcp-server`) — probe로 재현

- **버전**: `codex --version` → `codex-cli 0.144.4`
- **auth**: `codex doctor` → `stored auth mode: chatgpt`, `stored API key: false` (구독 토큰). API 키 없이 동작.
- **재현**: `node scripts/probe-codex-mcp.mjs` (initialize + tools/list, 모델 호출 없음)

노출 tool 2개 (probe 출력):
| tool | params | required |
|---|---|---|
| `codex` | approval-policy, base-instructions, compact-prompt, config, **cwd**, **developer-instructions**, model, **prompt**, **sandbox** | prompt |
| `codex-reply` | conversationId(deprecated), prompt, **threadId** | prompt |

> ⚠️ **확정된 것은 "기능을 요청할 schema가 존재한다"는 것뿐이다.** 실제 런타임 보장(쓰기 거부·문맥 유지)은 아래 "미검증"의 E2E에서 별도 확인한다.

- **read-only(spike #3) — E2E 검증됨(2026-07-29)**: `sandbox:"read-only"` + `approval-policy:"never"`로 codex에 repo 루트 파일 생성을 지시 → codex가 "읽기 전용 sandbox에 의해 거부됐습니다" 보고 + 실제 파일 부재를 독립 확인(`ls`). 리뷰어가 repo를 변조하지 않음이 실증됨.
- **stateful 재리뷰(spike #1) — E2E 검증됨(2026-07-29)**: 첫 `codex` 호출이 `threadId`(`019facda-…`) 반환. `codex-reply`에 그 threadId + 증분 fix-delta만 전달(원본 기준·이슈 설명 재전송 없음) → codex가 이전 라운드의 `CR-001`을 기억해 `(resolved)`로 판정. **실제 문맥 유지 실증.**
- **컨텍스트 주입 — E2E 검증됨(2026-07-29)**: `developer-instructions`에 loop.md 스키마 + code-review.md 기준 주입 → codex가 **정확한 strict 스키마**(첫 줄 `VERDICT:`, 산문·펜스 없음, `[CR-001] (blocking) (open) [file:line]`)로 응답. `ledger.mjs`가 실제 출력을 재요청 없이 파싱·병합.

## 플러그인 메커니즘 — Claude Code 문서 근거(2.1.207+)

- **MCP 선언(spike #1)**: `.mcp.json`(플러그인 루트) 또는 plugin.json `mcpServers`. stdio = `{command, args, env}`, `${CLAUDE_PLUGIN_ROOT}` 치환 지원. 툴명 = `mcp__plugin_<plugin>_<server>__<tool>`. → 본 리포 `.mcp.json` 참조.
- **`${CLAUDE_PLUGIN_ROOT}`(spike #2)**: 플러그인 설치 dir. mcp/hooks/commands/skills/agents 마크다운에서 치환. **번들 읽기용**(대상 repo cwd와 분리). 영속 상태는 `${CLAUDE_PLUGIN_DATA}`.
- **canonical 내용 주입(spike #2)**: **파일 내용 치환 변수는 없음.** 스킬/에이전트 마크다운의 `` !`cat "${CLAUDE_PLUGIN_ROOT}/instructions/loop.md"` `` dynamic injection으로 실행 전 **내용을 프롬프트 본문에 인라인**. (경로 참조 아님.)
- **커맨드 인자**: `$ARGUMENTS` / `$0`,`$1`.

## 라이브 codex review E2E — 검증됨 (2026-07-29)
`scripts/loop.mjs`(capture/delta/apply) + codex MCP로 REJECT→fix→APPROVE 1사이클을 실제 모델 호출로 완주:
1. `capture` baseline → 버그 함수(`average` 빈 배열 `0/0=NaN`) 추가 → `delta`(outOfScope `[]`, single-writer 확인).
2. `codex`(read-only, dev-instructions 주입) → `VERDICT: REJECT` + `[CR-001] (blocking) (open)`.
3. `apply --ns CR` → `committed:true`, `machineState:REVISING`, openBlocking 1.
4. 빈 배열 가드 추가 → 증분 `delta` → `codex-reply`(threadId 재사용) → `VERDICT: APPROVE` + `CR-001 (resolved)`.
5. `apply` → `machineState:APPROVED`, gateProgress `true`(open blocking 1→0), openBlocking 0.

→ read-only 쓰기거부·threadId 문맥유지·dev-instructions 스키마준수·ledger 결정적 파싱이 모두 실증됨.

## 프로바이더 스왑 스파이크 — 부분 검증 (2026-07-29)
스왑(결정 #8)의 새 메커니즘 = Codex가 `workspace-write` **빌더**(파일 쓰기). throwaway repo에서:
1. `capture` baseline → `codex`(`sandbox:"workspace-write"`, approval `never`)에게 "src/stats.js에 median() 추가" 위임 → **codex가 실제로 파일을 수정**(named export median 추가). threadId 확보. ✅ **workspace-write 쓰기 실증**(read-only 거부와 대비).
2. `delta`(baseline→post) → `changedPaths:["src/stats.js"]`, `outOfScope:[]`. ✅ **delta가 Codex 빌더의 write를 정확히 귀속**(code 루프; src/는 제외 대상 아님).
- codex-reply statefulness는 앞선 리뷰어 E2E에서 이미 실증(빌더 재수정도 동일 메커니즘).
- **이 스파이크가 Blocking #1도 재현**: `design.md`를 `.harnie/`에 두면 delta가 항상 빈값 → 설계 루프는 git-delta 대신 **설계 내용 주입**으로 계약 수정(review-loop-driver.md R1).

## 미검증 (다음)
- **스왑 풀 루프 E2E (B)**: Codex 빌더 REJECT→codex-reply 수정→Claude 리뷰 APPROVE 1사이클 end-to-end. 이 문서 작성 시점에는 미실행이었으나 **2026-08-10 통과 완료**(배포 ⑦ 前 P0 게이트였음).
- **플러그인 설치 검증(⑦)**: 위 E2E는 **로컬 .mcp.json**(툴명 `mcp__codex__codex`)로 수행하므로, 개인 GitHub push 후 **플러그인 설치** 시 `mcp__plugin_harnie_codex__*`로 뜨는지는 배포 단계(⑦)에서 별도 확인(B와 분리).
- 스킬(`quick`/`plan`)이 플러그인 로드 상태에서 `${CLAUDE_PLUGIN_ROOT}` 치환·canonical Read 주입까지 포함해 end-to-end로 도는 라이브 실행도 ⑦에서 확인(현재는 스크립트·codex 메커니즘 단위로 검증).

## effort 오버라이드 실측 (2026-08-26 · `instructions/model-matrix.md`에서 이관)

- Codex MCP 호출부는 `config: {model_reasoning_effort: "high"}`로 **호출 스코프 reasoning effort**를 줄 수 있다. 키 이름 `model_reasoning_effort`의 오타는 Codex가 **무음으로 무시**하므로 철자가 중요하다.
- Agent 툴로 디스패치되는 Claude 서브에이전트에는 effort 필드가 **없다**(부재 확인). 그래서 Claude 쪽 very-hard 티어는 effort가 아니라 **모델 승급**으로만 표현된다.
- 검증 출처: `~/Tradlinx/task2-recovery/effort-e2e.md`.

