# 결정 기록(ADR): 승인 프롬프트 감소 — (A) allowlist + (B') 좁은 훅 auto-allow

> 상태: **결정됨(2026-08-10, rev.2)**. 채택 = **(A) settings.json allowlist**(주 경로) + **(B') 좁은 훅 PreToolUse auto-allow**(설치 사용자용, 효과 제한 sanctioned 4종만). 기각 = **(B) 넓은 훅 auto-allow**.
> 배경: 루프 실행 중 harnie CLI·codex·아티팩트 쓰기가 매번 승인 프롬프트를 띄워 마찰이 큼.

## 결정

1. **(A) allowlist(주 경로):** harnie CLI·read-only 조회·codex MCP를 **사용자가 명시적으로 `settings.json`에 allowlist**한다. "무엇을 신뢰할지"는 **사용자·플랫폼 계층의 결정**(harnie 5계층 원칙)이며 플러그인이 대신 증명하지 않는다. `settings.local.json`은 사용자·프로젝트 소유라 플러그인과 함께 이동하지 않는다.
2. **(B') 좁은 훅 auto-allow(설치 사용자 무마찰):** allowlist가 플러그인과 함께 이동하지 않으므로, 설치 사용자에게도 **효과가 제한된 sanctioned 집합**만 PreToolUse `permissionDecision:"allow"`로 프롬프트를 skip한다 — `loop.mjs {capture, delta}`, `execution.mjs {completion, seal, seal-verify}`. 이는 넓은 (B)와 달리 안전이 증명 가능한 최소 집합이다:
   - **자동 허용:** 위 집합만(capture=임시 index+tree object·사용자 작업 트리 불변 / delta=`.harnie/…/delta.patch`만 write / completion=read-only / seal·seal-verify=자기 상태 파일 `.seal.json`만 write, 멱등·조건부).
   - **계속 프롬프트:** `apply`(ledger/state 전이)·`verify`(receipt+argv 실행)·`init`·`set-task`·`set-phase`·`arm-approval`, workspace-write codex, 모든 Write/Edit/Task, 일반 read-only Bash(범위 확대 안 함).
   - **불변식:** `autoAllow ⊂ deny:false` 엄격 부분집합(어떤 deny도 완화 안 함) · **완전한 active 바인딩**(root·slug·track) 전제 · 인터프리터 바인딩(bare `node`/`process.execPath`만, `/tmp/node` 거부) · `failClosed`면 auto-allow 없음.
   - **사용자 통제 유지:** PreToolUse `allow`는 user·project의 `deny`/`ask` 규칙에 밀린다(플러그인 공식 문서 확인).
   - 구현: `scripts/guards.mjs`(`decideBash`·`isAutoAllowSanctionedSub`·인터프리터 바인딩), `hooks/lib.mjs`(`allowPreTool`), `hooks/pretooluse.mjs`. Codex 크로스-모델 코드 리뷰로 검증.

## 왜 (B) 훅 auto-allow를 기각했나 — Codex 크로스-모델 설계 리뷰 3라운드

훅이 `permissionDecision:"allow"`를 반환해 sanctioned CLI 등을 무프롬프트로 통과시키는 안을 설계·리뷰했고,
**안전하게 만들수록 "증명 가능한 작은 부분집합"으로 수렴**함이 드러났다(정작 프롬프트의 큰 몫은 못 없앰):

- **DR-001:** codex `deny:false` 전체 auto-allow는 workspace-write 빌더(=repo 변경)까지 포함 → read-only만으로 축소.
- **DR-002(구조적):** "read-only" Bash가 실제로 read-only가 아님 — `rg --pre <cmd>`·`git diff --ext-diff`(외부 드라이버)·`uniq a b`·`tree -o`·경로지정 실행파일(`./cat`)이 실행/쓰기를 열음. 명령별 인자 문법을 다 검증해야 하는 토끼굴.
- **DR-004(구조적):** `node` sanctioned 판정에서 bare `node`는 PATH로 shim 해석될 수 있고, realpath 바인딩은 nvm·volta·asdf 정상 shim을 깨뜨림(usability 충돌).
- **DR-005:** `seal` 무조건 덮어쓰기 → 빌더 변경 後 재-seal로 baseline 오염 → auto-allow 불가. **해소(0.13 T3):** `seal`을 멱등·조건부로 바꿔(미검증 seal 위의 변경된 baseline 재기록을 fail-closed로 거부, `seal-verify`가 소비 표식을 남김 — `docs/execution-state.md` §5.4) 오염 경로 자체를 엔진이 막으므로 auto-allow 가능해졌다. 그 차단을 해제하는 `seal --after-mismatch`만 auto-allow에서 제외되어 종전대로 프롬프트가 뜬다.
- **DR-006:** `delta.patch`는 리뷰어 증거 → 수동 편집 auto-allow 시 리뷰 못 본 변경 승인 위험.
- **DR-007:** `init`은 비활성 경로라 auto-allow 도달 불가(무의견).
- 게다가 안전상 `apply`(ledger/state 전이)·`verify`(receipt)는 프롬프트를 **유지해야** 하는데, 이게 실행 중 프롬프트의 큰 몫 → 넓은 (B)로도 부분 해결.

**결론:** 넓은 (B)는 기각. (A)가 이 보안 표면 전체를 회피하고, 사용자가 `apply` 포함 전체를 **정보에 근거해 한 번에** 허용할 수 있어 프롬프트를 완전히 없앨 수 있다. 다만 (A)는 플러그인과 함께 이동하지 않으므로, 리뷰가 "증명 가능한 작은 부분집합"이라 인정한 **효과 제한 4종만** 남겨 **(B')**로 채택(위 §결정 2). 즉 리뷰가 수렴시킨 안전 핵을 폐기하지 않고 설치 사용자용 최소 무마찰로 살렸다.

## 부수 발견 — 기존 게이트 하드닝 후속(별건)

DR-002는 **현재 승인-前 Bash 게이트**(`guards.mjs`의 `isReadOnlyBash`)의 기존 약점이기도 하다: `rg --pre`·`git diff --ext-diff`·`uniq a b`·`tree -o`·경로지정 실행파일이 승인 前에도 실행/쓰기를 열 수 있다(§0.1 fallible 오케스트레이터의 사고 방지 목적을 약화). 이 auto-allow 결정과 **독립적으로** 하드닝할 후속 이슈로 분리(별도 task).

## 채택안 (A) — allowlist 구성

**대상(권장 allow):**
- harnie 상태 CLI: `node <plugin>/scripts/loop.mjs …`, `node <plugin>/scripts/execution.mjs …`.
- read-only 조회: `git status|diff|log|show …`, `ls`, `cat`, `grep`/`rg`, `node --test …` 등.
- codex MCP: `mcp__codex__codex`, `mcp__codex__codex-reply`(로컬) / `mcp__plugin_harnie_codex__*`(설치).

**위치:**
- **이 워크스페이스(harnie 개발/검증):** `.claude/settings.json`(프로젝트) 또는 개인 `settings.local.json`.
- **harnie 설치 사용자:** harnie README에 **권장 allowlist snippet**을 싣고 사용자가 소비 프로젝트 settings에 opt-in.

**안전 유지:** allowlist는 **positive allow**만 추가하며 harnie 강제 훅(H1 deny·H2 미완료 차단)은 그대로 — 위험 쓰기·미완료 확정은 여전히 차단된다.
