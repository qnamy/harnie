# harnie — 진행 상황 & 요구사항 (LIVING · 상시 로드)

> **임시 허브 문서.** 일반화가 완성될 때까지 개발 세션에서 항상 로드된다(`CLAUDE.md`가 연결). 완성 시 이 문서와 `CLAUDE.md`를 제거한다.
> 관련 문서는 아래 §5 인덱스로 두고 **필요할 때 on-demand로** 읽는다(전부 상시 로드하지 않음).
> 최종 갱신: 2026-08-10 (C 구현 APPROVED·푸시 완료 + **B 스왑 full-loop E2E ✅ 통과** — §7 핸드오프 참조. 남은 것 = ⑦ 배포).
>
> **네이밍(2026-07-29):** 플러그인/repo = **harnie**(개발 하네스 + 스킬 허브, 확장형, 단일 브랜드). 빌드/리뷰 워크플로 = 커맨드 `/harnie:build`(라우터)·`/harnie:quick`·`/harnie:plan`, 스킬 `quick`·`plan`, 에이전트 `harnie-{scout,designer,builder}`. 방법론 스킬(`pr-review` 등)은 그대로. 상태 디렉터리 `.harnie/`, 툴 네임스페이스 `mcp__plugin_harnie_codex__*`. 로컬 폴더 = `Tradlinx/harnie`.
> **프로바이더 대칭 스왑(2026-07-29, 결정 #8):** Claude=설계+코드리뷰 / Codex=설계리뷰+개발. 개발 빌더 = Codex(codex MCP `workspace-write`), 코드 리뷰어 = Claude. 루프 코어는 프로바이더 무관이라 코드 변경 없음.

---

## 1. 목적

사용자(gn.bak, DataPlatform 팀)의 AI 하네스 생태계를 정비하고, **일반화된 산출물을 이 repo(harnie)에 모아 개인 GitHub에 공개·전시**한다. 회사색은 사내 계층에 격리한다.

## 2. 최종 요구사항 — 5계층 모델

> **원칙: "무엇/왜는 harnie(일반화), 어떻게/어디(MCP·API·채널·리뷰어=회사색)는 플랫폼 계층."**

| 계층 | 내용 | 회사색 | 위치 | 전시 |
|---|---|:---:|---|:---:|
| 전역지침 | 순수 개인 선호(언어·코딩 철학) | ✕ | `~/.claude/` | 개인 |
| **plug-in `harnie`** | 일반화 지침+MCP+스킬, end-to-end 프로세스 | ✕ | **이 repo** | ✅ |
| Tradlinx 지침 | 회사색 config·도메인(채널ID·내 id·bot) | ✓ | `~/Tradlinx/` | ✕ |
| DataPlatform 지침 | 팀 세부(owner repo·repo 관계) | ✓ | `~/Tradlinx/DataPlatform/` | ✕ |
| 루틴 | 전역+Tradlinx+일반화 스킬로 업무 자동화 | 실행 시 | `~/.claude/scheduled-tasks/` | ✕ |

**확정 원칙**
- **A(이전):** 일반화 지침은 참조 문서로 남기지 않고 **harnie 스킬로 이전**. `~/.claude`·루틴·Codex 모두 그 스킬을 사용(Claude=호출, Codex=오케스트레이터가 스킬 내용 주입).
- **B(delivery tail):** PR 생성·리뷰요청의 "무엇"은 harnie 스킬, "어떻게"(MCP/API·채널·필수 리뷰어)는 Tradlinx 지침·루틴.
- **on-demand:** 전역지침만 상시 로드. Tradlinx 지침은 필요한 스텝에서 명시적 read(항상 로드 X).

## 3. 두 프로세스

**빌드(플러그인 코어):** 버그/작업 → 코드 리드 → 설계 → 설계리뷰 → 개발 → 개발리뷰 → PR 생성 → 리뷰요청. (`/harnie:build`·`quick`·`plan` — **오케스트레이터 코어 구현됨**; v0 완성은 ⑥.6 A/C/B 게이트 미완.)

**리뷰 라이프사이클:** PR 리뷰 → 이전(Active) 댓글 해결 → 머지(Completed) 댓글 해결 → **품질 강제화(반자동: 반복 지적을 모아 lint/기준으로 승격, 사용자 선택)** → 코드 작성 프로세스로 연결.

**스킬 패밀리(일반화 방법론):** `pr-review`(PR 판단·기준, issue/discuss/nit, approval) / `comment-resolve`(응답이 지적을 해소했는지 검증 — pr-review 기준·해제조건 사용) / `deploy-approval`(배포 게이트) / `quality-digest`(반복 지적 → 강제 규칙 제안, 인간 게이트) / `pr-delivery`(PR 본문·리뷰요청 "무엇" — 빌드 delivery-tail).

> **PR 리뷰 ↔ 개발 중 리뷰 분리:** `pr-review`(외부 PR 평가, approval-bias)와 **개발 중 in-loop 리뷰**(REJECT-bias, 크로스-모델 빌드 루프 — `instructions/code-review.md`+`loop.md`)는 **별개 자산**이다. 스킬명이 `pr-review`인 이유: native 빌트인 `/code-review`(작업 diff 리뷰)와 충돌 회피 + 두 리뷰 구분.

## 4. 진행 상황

**완료**
- REVIEW.md 최종본: `issue:`/`discuss:`/`nit:` 규약(issue·discuss 차단, nit 비차단), discuss는 승인-영향 시에만, 우선순위≠접두어 두 축, 해제 조건, 가드레일 6종. 내부 정합.
- 자동 리뷰 루틴 4종 규약 동기화(접두어·투표·경로 B 접두어 구동).
- **`pr-review` 스킬 생성**(`skills/pr-review/SKILL.md`) — REVIEW.md 내용 일반화 이전, 회사색 제거, what-only. **A의 ① 스킬 생성분.** (native `code-review` 충돌 회피 + 개발 중 in-loop 리뷰와 분리해 `pr-review`로 명명.)
- **`comment-resolve` 스킬**(`skills/comment-resolve/SKILL.md`) — 두 resolver 루틴 검증 방법론 일반화(경로 A 답변검증 / 경로 B 접두어 구동 / active·merged + 재투표 권고).
- **`deploy-approval` 스킬**(`skills/deploy-approval/SKILL.md`) — qa-deploy 게이트 일반화(차단=`issue` 급 검토 → 승인/보류 → 정족수 도달 시 상태 전진 권고).
- **`quality-digest` 스킬**(`skills/quality-digest/SKILL.md`) — 반복 지적 클러스터 → 강제 규칙(lint/CI/기준) 승격 제안, 인간 게이트(자동 적용 금지).
- → **④ 방법론 스킬 4종(pr-review 포함) 완료.** 판단만, 실행은 호출자.
- **Tradlinx 지침 신설**(`~/Tradlinx/ROUTINE-CONFIG.md`) — 4개 루틴 회사색(신원·채널·ADO/Jira 좌표·경로·문구·타이밍) consolidate, 봇토큰은 경로만. **회사색 격리 경계 확립.** 남은 ④: 루틴을 이 config·harnie 스킬 호출로 rewire(배포 단계 ②와 함께).
- **`pr-delivery` 스킬**(`skills/pr-delivery/SKILL.md`) — 빌드 delivery-tail "무엇": PR 본문(무엇·왜·검증·범위) + 리뷰요청 내용. 실행(플랫폼·채널·필수 리뷰어)은 호출자/Tradlinx 지침. **⑤ 완료.**
- **⑥ 빌드 오케스트레이터 코어 완료**(2026-07-29):
  - `commands/{build,quick,plan}.md` — 라우터(크기분류+announce+override) + 트랙 강제 진입점.
  - `skills/quick/SKILL.md` — quick 오케스트레이터(intent/read/**상세설계(경량)+리뷰**/write/verify/코드리뷰/report, 단계별 리뷰 축약 없음. 상세 고도만).
  - `skills/plan/SKILL.md` — plan 오케스트레이터(PHASE A: ground→route→**아키(정식)+리뷰[조건부]→상세(정식)+리뷰**(각 독립 루프, 코드 前)→승인게이트 / PHASE B: 실행→코드리뷰→**최종웨이브(Coverage·Quality·Runtime·Scope)**). 설계 고도 = 전역 ARCH/DETAIL "정식으로" 스위치 재사용. Final Wave 게이트명 = 자기설명적(Coverage·Quality·Runtime·Scope, 결정 #7).
  - `instructions/review-loop-driver.md` — quick·plan 공통 루프 CLI·codex 배선(R1~R5), canonical 주입(중복 제거).
  - `instructions/design-authoring-{arch,detail}.md` — 설계 **작성** 출력 계약(고도별 경량/정식 분기) 이식. designer body는 역할·원칙만 남기고 계약을 프로필로 분리(주입) → 작성 지침 자기완결화(전역 `~/.claude/ARCH·DETAIL` 의존 제거). 모드=분기, 고도=프로필.
  - `scripts/loop.mjs` — capture/delta/apply CLI. loop.md 상태전이(REVIEWING→APPROVED|REVISING|STALLED)를 코드로 고정, LLM은 ①② 정성 progress만 `--progress`로 주입. **테스트 22(전체 60 pass).**
  - **크로스-모델 리뷰 반영(2026-07-29, codex 리뷰 3라운드)**: ① `--limit` 양의 정수 검증(NaN/0/음수면 STALLED 게이트 무력화 → fail-closed). ② **STALLED 래치 + 명시적 `--reentry <new-evidence|external-state|user-decision|scope-change>`** — gateProgress·APPROVE 같은 사후 사실로 자동 해제 금지, 재진입 없으면 `needsReentry`(ledger·state 불변). ④ plan·quick 경로 단일 스킴 `.harnie/<track>/<slug>/review/<name>/`로 통일. **래치 우회 차단(2·3라운드)**: (a) `--state` **필수화**, (b) 기존 `state.json`은 `machineState` **필수**(파일 부재=정당한 초기 vs 필드 누락=손상 구분), (c) **ledger·state 존재 여부 XOR·부모 디렉터리 불일치 fail-closed**(기존 ledger + 새 state 경로 위장 차단; 잔여 = 둘 다 새 경로면 새 단위와 구분 불가 → 호출자 불변식). ③(code-review.md의 DataPlatform 규칙 overlay 추출)은 ⑦ 공개 전 게이트로 유지. loop.md·review-loop-driver.md(영문 canonical) 계약 동기화.
  - **codex 라이브 E2E 검증**: REJECT→fix→APPROVE 1사이클 완주(read-only 쓰기거부·threadId 문맥유지·dev-instructions 스키마준수·ledger 결정적 파싱 실증). → `docs/codex-mechanisms.md`.
  - **남은 ⑥**: 플러그인 설치 상태의 라이브 실행(`${CLAUDE_PLUGIN_ROOT}` 치환·스킬 로드·`mcp__plugin_harnie_codex__*` 툴명)은 배포 단계(⑦)에서 확인.

**남은 액션**
- **②③는 배포 단계(⑦)로 이연**: `/harnie:pr-review` 호출은 harnie 플러그인 설치가 전제. 표준 설치 = 개인 GitHub push 후 `source:{github,repo}` marketplace(플러그인=repo 루트 유지, restructure 불필요). 로컬 강제 설치는 throwaway restructure(플러그인을 하위 dir로) 필요 → 안 함. **그때까지 루틴은 REVIEW.md 유지(안 깨짐), `pr-review`는 staged(전환 시 재동기화).**
- **② 전환**: `~/.claude/CLAUDE.md` 라우터 "PR 리뷰 → `/harnie:pr-review` 사용" + 루틴 4종 "REVIEW.md 읽기 → `/harnie:pr-review` 호출"(on-demand, canary 1개 검증 후 나머지).
- **③ 은퇴**: `~/.claude/REVIEW.md` 제거(삭제 직전 확인).
- **④** `comment-resolve`·`deploy-approval`·`quality-digest` 스킬 + 루틴을 얇은 호출자로 + **Tradlinx config 추출 → Tradlinx 지침 신설**(루틴이 on-demand read).
- **⑤ delivery tail(B)**: PR 생성·리뷰요청 "무엇" 스킬 + Tradlinx 지침에 "어떻게".
- **⑥ 코어 완료**(위 완료 참조). 남은 것: 플러그인 설치 상태 라이브 E2E는 ⑦과 함께.
- **⑦** 공개 push(개인 GitHub) + 플러그인 설치 라이브 검증(`mcp__plugin_harnie_codex__*`·`${CLAUDE_PLUGIN_ROOT}`) + ②③(리뷰 전환·루틴 rewire·REVIEW.md 은퇴) + 포트폴리오 서사.

## 5. 관련 문서 인덱스 (on-demand)


**harnie 설계 근거**
- `docs/architecture.md` — 스킬·에이전트·크로스-모델 리뷰 루프 설계(구 HARNIE-DESIGN)
- `docs/execution-state.md` — ⑥.6 C 상세 설계(4파일: plan/manifest/execution/notepad·권위=planHash 고정 manifest+review-state·빌더 lean(메인 트리+seal, worktree post-v0)·강제 훅 2개·read-only 리뷰어·passive resume·위협모델 §0.1)(구 EXECUTION-STATE-DESIGN)
- `docs/codex-mechanisms.md` — codex MCP·플러그인 메커니즘 확정 사실(구 SPIKE-mechanisms)

**harnie 런타임 계약(canonical)**
- `instructions/loop.md` — 리뷰 루프 상태머신·ledger 스키마(별도, `(blocking|non-blocking)`)
- `instructions/review-loop-driver.md` — 루프 CLI·codex 배선(R1~R5, quick·plan 공통)
- `instructions/verification-tiers.md` — 검증 tier
- `instructions/code-review.md` — **개발 중 in-loop** 리뷰 기준(REJECT-bias, `pr-review` 스킬과 별개, 팀규칙 포함 → 추출 대상)
- `instructions/design-review.md` — 설계 리뷰 기준(아키·상세 두 고도, 호출자가 고도 신호)
- `instructions/design-authoring-{arch,detail}.md` — 설계 **작성** 출력 계약(고도별 경량/정식 분기). designer body=역할·원칙, 계약=주입 프로필. 전역 ARCH/DETAIL 일반화 이전본(harnie 자기완결).

**harnie 자산**
- `skills/{pr-review,comment-resolve,deploy-approval,quality-digest,pr-delivery}/SKILL.md` — 일반화 방법론 스킬(판단·작성만, 실행은 호출자). `pr-review`=PR 판단 단일 소스(issue/discuss/nit)
- `agents/{harnie-scout,harnie-designer,harnie-builder,harnie-reviewer}.md` — 역할 에이전트 영문 실행 정본(`*-ko.md`는 한국어 미러, harnie-reviewer=read-only 코드 리뷰어, ⑥.6 C)
- `scripts/ledger.mjs`·`delta.mjs`·`loop.mjs` — loop 계약의 결정적 구현(ledger·delta 캡처·apply 상태전이)
- `scripts/execution.mjs` — plan 실행상태 엔진(⑥.6 C): sentinel-first init·manifest/planHash·완료 재도출·seal·verify·승인/threadId 등록. 권위 재도출 코어
- `scripts/guards.mjs` — 강제 훅 순수 결정 함수(H1 Write/Bash/Task/Codex, H2 Stop)
- `hooks/{hooks.json,lib.mjs,pretooluse,stop,posttooluse}.mjs` — H1 승인前·control 가드 / H2 미완료-확정 방지(HARNIE_STATUS footer) / PostToolUse 관찰 등록 + **좁은 auto-allow**(sanctioned 4종 capture·delta·completion·seal-verify 프롬프트 skip, f9ea0aa). 테스트 전체 121 pass

**외부(회사색·개인)**
- `~/.claude/REVIEW.md` — PR 리뷰 기준(② 후 은퇴 예정, `pr-review` 스킬로 이전됨·staged)
- `~/.claude/PR.md` — PR 절차(ADO·투표 등, 회사색 → Tradlinx 지침 후보)
- `~/.claude/CLAUDE.md` — 전역 라우터
- `~/.claude/scheduled-tasks/{slack-pr-review-autopilot, azdo-pr-comment-resolver, azdo-pr-completed-comment-resolver, qa-deploy-approval-autopilot}/SKILL.md` — 리뷰/승인 루틴
- `~/Tradlinx/ROUTINE-CONFIG.md` — **Tradlinx 지침**: 자동화 실행 회사색(신원·채널·ADO/Jira 좌표·경로·문구·타이밍), 봇토큰은 경로만
- `~/Tradlinx/DataPlatform/*.md` — 팀 지침(DOMAIN-MAP·PROBLEMS 등)
- memory: `harness-generalization-plan.md` — 프로그램 메모리

## 6. 다음 한 걸음

**⑥ 빌드 오케스트레이터 코어 완료**(commands 3종 + skills 2종 + review-loop-driver + loop.mjs CLI, 테스트 60 pass, codex 라이브 E2E 검증, 크로스-모델 리뷰 반영). **⑥.5 harnie 리브랜드 완료**(2026-07-29): 커맨드 build/quick/plan·스킬 quick/plan·에이전트 harnie-*·`.harnie/`·`mcp__plugin_harnie_codex__*`·런타임 prefix `harnie-loop:`·테스트 tmpdir·probe까지 전반. 프로바이더 대칭 스왑(결정 #8). 스왑 workspace-write 빌더 스파이크 부분검증.

**⑥.6 = v0 필수(⑦ 前 게이트, codex 협의로 확정) — 순서 A → C → B.** 현재 위치: **A ✅ 완료 · C 설계 ✅ APPROVED(rev.10) · C 구현 ✅ APPROVED(Codex 코드리뷰 12라운드, blocker 없음, 테스트 115 pass) → `origin/main` 푸시 완료(`9fcf719`, `github.com:qnamy/harnie`) · B ✅ 스왑 full-loop E2E 통과(2026-08-10) · 다음 실행 = 「⑦ 배포」**.
- **A (P1) ✅ 완료:** per-turn intent 재분류(quick·plan) + **notepad protocol**(plan: 단일 writer=오케스트레이터, 위임 전 read·완료 후 append·덮어쓰기 금지·재사용 지식만).
- **C (P2): 설계 rev.10 APPROVED + 구현 ✅ APPROVED(Codex 코드리뷰 12라운드, blocker 없음, 테스트 115 pass) → `origin/main` 푸시 완료.** 배송물: `scripts/execution.mjs`(sentinel-first init·manifest 파생·planHash·완료 재도출·authority seal 기록/비교·verification argv 실행(execFile, shell 없음)·scopeHash·approve 바인딩·builder/readonly threadId 등록·set-task/set-phase advisory; fail-closed·atomic) + `scripts/execution.test.mjs`, `scripts/guards.mjs`(H1/H2 순수 결정 함수) + `scripts/guards.test.mjs`, `scripts/loop.mjs` CR `--artifact <postSHA>`→`reviewedPostSHA` + `scripts/loop.test.mjs`, `hooks/{hooks.json,lib.mjs,pretooluse.mjs,stop.mjs,posttooluse.mjs}` + `hooks/hooks.test.mjs`(음성/통합·matcher), `agents/harnie-reviewer.md`(read-only), driver·quick·plan 동기화(main-inline 코드리뷰 제거→harnie-reviewer, plan A5 AskUserQuestion 승인 바인딩·`harnie-manifest` 블록·`HARNIE_STATUS` footer, B2 seal·set-task/B3 seal-verify·--artifact/B4 verify/B6 completion). **무효화는 명시적 서브커맨드가 아니라 권위 재도출로 emergent**(§1 원칙 충실). **Codex 코드리뷰 1라운드(REJECT) 반영**: (1) 완료 재도출을 **현재 working tree ↔ 리뷰 tree 바인딩**으로 수정(리뷰 후 코드 변경이면 미완료 — 기존엔 frozen reviewedPostSHA만 비교해 사후 수정이 안 잡힘) (2) 승인 게이트를 **manifest+planHash 권위로 판정**(advisory phase 불신 — `set-phase executing` 우회 차단) (3) Bash 가드 **phase-aware**(승인 前 리다이렉트·mkdir·인라인 인터프리터 등 소스 쓰기 deny) (4) 훅 **fail-closed 전체 catch**(예외 시 PreToolUse deny·Stop block — exit 1 fail-open 방지) (5) 승인 질문 **arm 게이트 + 선택 값만 검사**(질문 텍스트 "승인" 오탐·타 질문 오-바인딩 차단) (6) Final Wave **4게이트 강제**(누락 거부) (7) codex 빌더 **정확히 workspace-write+cwd=root**만 (8) `harnie-designer` read-only 허용(planning 위임) (9) `--artifact` stale 이월 제거 (10) 스킬 CLI `--root` 보강. **Codex 코드리뷰 2라운드(REJECT) 반영**: (11) `set-phase closed`/역전이로 Stop 우회 차단 — **승인된 active run이면 Stop이 phase 무관 항상 완료 재도출**(+closed는 complete일 때만, 승인 후 planning 역전이 금지) (12) sanctioned CLI 임의경로 쓰기 차단 — `loop.mjs`가 `--out/--ledger/--state`를 `.harnie/` 안으로 검증 + Bash 가드 **승인 前 read-only allowlist**(git apply·npm·writer 스크립트·리다이렉트 deny) (13) `approved`를 **현재 plan.md에서 planHash 재계산**해 판정(승인 후 plan.md 수정·manifest 변조 탐지) (14) 승인 arm **일회성 소비** + pending을 tool_use_id 매칭 시 소비(거절 후 stale·타 질문 덮어쓰기 차단) (15) codex 빌더 **cwd=root 필수**(미지정 deny) (16) CR apply **--artifact 필수화**(quick 포함 리뷰-tree 바인딩 강제). **Codex 코드리뷰 3라운드(REJECT) 반영**: (17) **self-승인 우회 차단** — `approve`·`pending-approval`·`register-*`를 CLI에서 제거(훅 in-process 전용, sanctioned Bash로 self-승인·thread 위조 불가) + `isControlPath`를 권위 파일만으로 좁혀 round-N.txt·delta.patch 정당 쓰기 허용(기능 파손 수정) (18) `.harnie` 경로 검증을 **resolve+realpath 정규화**로(`.harnie/../src`·symlink 우회 차단) (19) read-only allowlist에 **쓰기 옵션 denylist**(find -delete·sort -o·yq -i·git --output) + 위험 명령(find/sort/yq) 제외 (20) **closed+권위깨짐 Stop 우회 차단** — Stop이 approvalEvidence 있고 approved=false면 phase 무관 block + set-phase final-wave/closed는 authorityApproved 선검사 (21) 승인 **질문·옵션 정확 바인딩**(arm이 질문/승인옵션 고정, Pre 대조, Post 선택값 정확일치) (22) sanctioned CLI를 **신뢰 절대경로 정확일치**로 pin(`/tmp/scripts/loop.mjs` 위장 차단). **Codex 코드리뷰 4라운드(REJECT) 반영**: (23) Bash 가드가 **개행·프로세스치환(`<(...)`)·리다이렉트** 전면 인식(밀반입 `git status\\nrm …`·`cat <(rm …)` 차단) (24) 비-sanctioned Bash의 **.harnie 접근 phase 무관 전면 차단**(승인 후 `find .harnie -delete`·`git clean -fd .harnie`·`node -e` 포함) (25) Write/Edit 경로 **symlink-해소 canonical containment**(repo 밖 탈출 deny) (26) sanctioned CLI를 **active repo에 바인딩**(`--root`·`--out/--ledger/--state`가 활성 `.harnie` 안일 때만) (27) 승인 질문 **정확 바인딩 강제**(`arm-approval --question` 필수, 실제 질문/옵션 대조 없으면 fail-closed) (28) 응답에서 **pending 질문 키의 선택값만** 조회(답 평탄화 폐기 → 다른 질문의 "승인" 오연결 차단). **Codex 코드리뷰 5라운드(REJECT) 반영**: (29) sanctioned CLI를 **서브커맨드별 argv로 active context 바인딩**(execution.mjs `--root`·`--slug`·`--track`, loop.mjs positional repo·출력경로 — **stale slug verify로 과거 manifest executable 승인前 실행 차단**) (30) loop.mjs 출력 containment를 **active `--root` 필수 + realpath**로(`.harnie/link → src/.harnie` symlink 탈출 차단; 가드 lexical 검사의 backstop) (31) `.harnie` 매칭 **case-insensitive**(macOS 기본 FS의 `.HARNIE`·`MANIFEST.JSON` 우회 차단) (32) answerForQuestion **단일 키 fallback 제거**(`answers` plain object의 question/header 정확 키 일치만 — 비-answers 객체·타 질문 오연결 차단). **Codex 코드리뷰 6라운드(REJECT) 반영**: (33) **중복 플래그 거부**(가드는 first-value·CLI는 last-wins라 `--root /repo … --root /other` 우회 → 가드+parseArgs 둘 다 dup fail-closed) (34) **CR artifact = 현재 working tree 검증**(40-hex 형식만이 아니라 `captureTree(root)`와 일치 — stale/임의 SHA·리뷰 후 변경 즉시 차단, quick의 유일 게이트) (35) sanctioned CLI를 **active slug/positional repo/track에 바인딩**(execution.mjs `--slug`===active, loop.mjs positional repo===active — stale slug verify 차단) + loop 출력경로를 **active review-unit** 하위로 (36) loop.mjs apply **review-unit 구조 강제**(ledger.json·state.json·round-N.txt 같은 dir — unrelated review·타 unit 상태 변경 차단). **Codex 코드리뷰 7라운드(REJECT) 반영**: (37) **execution.mjs parseArgs도 중복 플래그 거부**(loop.mjs만 고쳤던 누락 — `init --root A … --root B`로 다른 repo 상태 생성 차단, init 前엔 훅 보호 불가) (38) loop.mjs **review symlink 우회 차단**(canonical review 부모가 canonical ledger 부모와 같고 `<root>/.harnie` 안인지 — lexical dirname 검사만으론 `round-1.txt → 외부 APPROVE` symlink 통과). **Codex 코드리뷰 8라운드(REJECT) 반영**: (39) **state.json canonical colocation 추가**(37~38에서 ledger·review만 canonicalize했고 state는 lexical dirname이라, `state.json → 다른 unit의 state.json` symlink로 타 unit 상태 변경 가능했음). **Codex 코드리뷰 9라운드(REJECT) 반영**: (40) colocation을 **lexical identity 바인딩**으로 강화 — "세 canonical 부모가 서로 같은지"만 보면 ledger·state·review를 **셋 다 함께** 다른(stale) unit으로 symlink할 때 canonical 부모끼리 일치해 통과했음. 이제 각 경로가 `realRoot + lexical relative`(자기 lexical 위치)와 canonical이 일치하는지 검사해 **어떤 symlink 재지정도 거부**(stale unit 우회 차단). **10라운드 APPROVE(blocker 없음).** **11라운드(문서 리뷰, REJECT) 반영**: (41) `hooks.json` matcher가 bare `codex`(exact-name 목록)라 MCP 툴명(`mcp__(plugin_harnie_)?codex__codex(-reply)?`)에 매치되지 않아 **PreToolUse codex 게이팅·PostToolUse threadId 등록이 아예 발화하지 않던 P0** 수정 — native exact-list + codex **정규식** matcher로 분리, dispatcher matcher 검증 테스트 추가(테스트가 훅 스크립트를 직접 실행해 matcher를 우회하던 gap도 메움). 이어 codex matcher를 `^…$`로 **앵커링**(다른 MCP namespace·접두/접미 부분일치 차단)하고 그 음성 테스트 추가. AGENTS.md는 `@import`가 Codex에 미보장이라 **명시적 상태 문서 읽기 지침**으로 전환(CLAUDE.md는 `@import` 유지, 미러 규칙에 명시). **12라운드 APPROVE — C 구현 최종 승인, `origin/main` 푸시(`9fcf719`).** 남은 것 = **B(스왑 full-loop E2E)** + 플러그인 설치 상태 라이브 훅 발화(⑦).
  <details><summary>원 구현 체크리스트(§11)</summary>(요약: `scripts/execution.mjs` 신설[sentinel-first init·manifest 파생·planHash·전이/무효화·완료 재도출·authority seal·verification argv 실행·scopeHash 계산·PostToolUse 등록], `scripts/loop.mjs`에 CR `--artifact <postSHA>`→`reviewedPostSHA` 기록, `hooks/hooks.json`+H1(승인前·control 쓰기 가드)·H2(미완료-확정 방지, `HARNIE_STATUS` footer)·PostToolUse(builder threadId·AskUserQuestion 승인) 배송, `harnie-reviewer` 에이전트[tools=Read,Grep,Glob], driver·quick·plan에서 main-inline 코드리뷰 제거, plan 스킬 A5를 AskUserQuestion 승인 바인딩·plan.md에 기계파싱 manifest 블록·`HARNIE_STATUS` footer emit). 음성 테스트 세트도 §11.** 관통 계약: **위협모델 §0.1**(fallible·over-eager 오케스트레이터/빌더의 실수 방지, 세션 통제 적대적 main은 비목표) / 권위 = **planHash 고정 immutable `manifest.json` + review-state ledger + verification receipt**(execution.json advisory) / **빌더=lean(메인 트리, DR-013)** + authority-state seal·delta 제외·loop.mjs fail-closed로 실수-훼손 탐지(worktree 격리는 post-v0) / 4파일(plan/manifest/execution/notepad) / 강제 훅 2개(H1 승인前·control 쓰기 / H2 미완료-확정 방지, `HARNIE_STATUS` footer·sentinel-first·fail-closed) / 승인=실제 승인 툴(AskUserQuestion) PostToolUse 관찰 / builder threadId PostToolUse 등록·최초호출 부트스트랩 / verification=manifest command argv 실행·postSHA 고정 / abort 제거 / resume=durable review-state 재도출 / read-only `harnie-reviewer` / hooks.json·별도 execution.mjs. loop.md producer-neutral(완료). **rev.10 = Codex 8라운드 리뷰까지 반영, DR-001~014 전부 resolved, 오픈 blocker 없음.**</details>
- **B (P0, 게이트):** ✅ **스왑 full-loop E2E 통과**(2026-08-10, throwaway repo `scratchpad/e2e-repo`). 실제 Codex MCP 빌더(`mcp__codex__codex`/`-reply`, workspace-write)가 `sum` 구현→Claude `harnie-reviewer`(read-only) **REJECT**(CR-001·CR-002 blocking)→`codex-reply` 수정→**APPROVE**(resolved)→`loop.mjs apply` ledger **APPROVED**→`execution.mjs verify` receipt(`node --test` exitCode 0)→Final Wave 4게이트 APPROVED→`completion` **complete=true**→Stop **통과**. 음성 4종 통과: 승인 前 소스 쓰기 deny·active slug 밖 deny·미완료 Stop block·정직한 `HARNIE_STATUS: INCOMPLETE` 재호출 통과. 훅은 플러그인 미설치라 엔트리 스크립트를 stdin JSON으로 직접 구동(설치 자동발화=⑦). 상세: `scratchpad/B-e2e-results.md`.
- **⑦ 배포:** ✅ 개인 GitHub push 완료(`github.com:qnamy/harnie` `main` = `9fcf719`). 남은 것 = `.claude-plugin/marketplace.json` 추가 + 설치 라이브 검증(`mcp__plugin_harnie_codex__*` 툴명·`${CLAUDE_PLUGIN_ROOT}` 치환·훅 실제 발화) → ②③(REVIEW.md 은퇴·루틴 rewire) → 포트폴리오 서사.

---

## 7. 다음 세션 이어가기 (핸드오프, 2026-08-10)

- **공개 완료**: `github.com:qnamy/harnie` `main` = `1342e9c`(= `9fcf719` C구현 + `1342e9c` 스킬 출력언어 섹션 docs 커밋, fast-forward push). 테스트 115/115 pass. C 구현 = Codex 크로스-모델 코드리뷰 12라운드 APPROVE(REJECT 11회 반영).
- **WIP 마무리 완료**: `skills/comment-resolve`·`skills/deploy-approval` 영/한 출력언어 섹션 → 커밋 `1342e9c` → `main` push 완료.
- **B (P0 게이트) 완료**: 스왑 full-loop E2E ✅ 통과(2026-08-10). §6 B 항목·`scratchpad/B-e2e-results.md` 참조. (테스트/상태파일은 throwaway repo에 있고 harnie repo 자체엔 커밋 산출물 없음 — E2E는 스킬/스크립트 계약의 라이브 검증이라 코드 변경 불요.)
- **바로 다음 순서 = ⑦ 배포**:
  1. `.claude-plugin/marketplace.json` 추가 → `/plugin marketplace add qnamy/harnie` → `/plugin install harnie@harnie`.
  2. 플러그인 로드 상태에서 **훅 자동발화** 라이브 검증: `${CLAUDE_PLUGIN_ROOT}` 치환·`mcp__plugin_harnie_codex__*` 툴명·`hooks.json` matcher(PreToolUse codex 게이팅·PostToolUse threadId 등록·Stop) 실제 발화. (B는 엔트리 스크립트 직접구동으로 검증했으니, ⑦은 "Claude Code가 등록된 훅을 자동 호출하는가"만 확인.)
  3. 이후 ②③(REVIEW.md 은퇴·루틴 rewire) → 포트폴리오 서사.
  3. **⑦ 설치 라이브 검증**: `.claude-plugin/marketplace.json` 추가 → `/plugin marketplace add qnamy/harnie` → `/plugin install harnie@harnie` → 플러그인 로드 상태에서 `${CLAUDE_PLUGIN_ROOT}` 치환·`mcp__plugin_harnie_codex__*` 툴명·훅(`hooks.json` matcher) 실제 발화 확인.
- **주의**: 커밋 author 이메일이 로컬 호스트명(`bakgyunam@…MacBookPro.local`)이라 GitHub 계정에 커밋이 연결 안 됨 — 필요 시 `git config user.email <github-email>` 후 amend + `git push --force-with-lease`.
- **검증 명령**: `node --test scripts/*.test.mjs hooks/*.test.mjs`(현재 121 pass).

**제외(v0 밖 과잉):** 전문 에이전트 로스터·adversarial lane·auto-continue·다중세션 retry.
