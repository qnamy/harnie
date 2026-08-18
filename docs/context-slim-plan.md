# harnie 컨텍스트 오버플로 해소 — 실행 설계 (핸드오프)

> **작성**: 2026-08-18, 진단 세션(Fable 5). **실행**: 새 Sonnet 5 세션이 이 문서를 읽고 수행한다.
> **문제**: dev-full/dev-quick 실행 중 오케스트레이터 세션의 컨텍스트 창이 가득 차 에러 발생.
> **진단 요약**: ① dev-full SKILL.md 51.6KB 통째 로드, ② Step 0 지침 7종(≈44KB) 선로드, ③ 설계·기준·스키마 문서를 매 위임/라운드마다 **인라인 주입**(중복 추정 36–94k 토큰, 태스크 3개·평균 2라운드 기준), ④ plan.md 8~10회 재읽기, ⑤ 빌더 응답의 코드 echo. 훅 주입은 세션당 ~250토큰으로 무관.

---

## 0. 불변 제약 (실행 세션이 반드시 지킬 것)

- **엔진 무변경**: `scripts/*.mjs`, `hooks/*.mjs`, `hooks.json`은 건드리지 않는다. 이번 작업은 **문서 계약(지침·스킬·에이전트 본문) 수정만**이다.
- **영문 정본 + ko 미러 동시 갱신**: 수정하는 모든 `*.md`는 대응 `*-ko.md`에 같은 변경을 반영한다(CLAUDE.md 언어 정책).
- **결정적 게이트 불변**: 승인 게이트·Stop 재도출·sanctioned CLI·`.harnie` 보호는 훅에 있으므로 이번 변경의 영향 밖. loop.mjs의 VERDICT/ISSUES fail-closed 파싱이 스키마 미준수의 백스톱임을 전제로 한다(라이브 실증됨 — PROJECT-STATUS §6.7 ② "needsReRequest 목격").
- **검증**: `node --test scripts/*.test.mjs hooks/*.test.mjs` 229 pass 유지(문서 변경이라 깨질 일 없어야 정상). 완료 후 남은 인라인 주입 문구 grep 확인(§5).
- **두 트랙 동시 적용**: 주입 규칙 원천이 공유 파일에 있으므로 dev-full만 고치면 dev-quick과 계약이 어긋난다. **P1·P2는 반드시 두 트랙 + 공유 지침을 한 번에** 고친다.

## 0.1 사실 확인 (설계 근거)

- codex MCP `sandbox:"read-only"`는 **쓰기만 거부, 읽기는 가능**(`docs/codex-mechanisms.md` 라이브 검증). `workspace-write` 빌더도 읽기 가능. 리뷰 대상(`.harnie/**/design.md`, `delta.patch`, `plan.md`)은 모두 `cwd=<repo>` 안에 있다.
- `harnie-reviewer`·`harnie-designer`는 Read/Grep/Glob 툴 보유 → 절대경로를 주면 스스로 읽을 수 있다.
- 기존 "path reference alone does not guarantee the model reads it"(loop.md L3, dev-quick Step 0) 문구는 adherence 우려에서 온 설계 결정이다. 전환의 상쇄책: (a) 스키마는 loop.mjs가 fail-closed로 파싱하므로 안 읽으면 needsReRequest로 잡힘, (b) 리뷰 기준·스키마를 **에이전트 본문(서브에이전트 시스템 프롬프트 = 결정적 로드)** 으로 이동, (c) 위임 프롬프트에 "응답 첫 줄에 읽은 파일 목록을 명시하라" 요구.
- **주의(실행 세션에서 실측 1건)**: codex가 `${CLAUDE_PLUGIN_ROOT}` 경로(대상 repo 밖)를 읽을 수 있는지 확인. 안 되면 codex용 기준 문서는 "스레드당 1회 주입"으로 폴백(P1-c 참조 — codex-reply 스레드 재사용 덕에 라운드마다 재주입은 어차피 불필요).

---

## P1 — 인라인 주입 → 경로 전달 + 강제 읽기 (최우선, 기대 절감 최대)

원칙: **오케스트레이터 발신 프롬프트에 문서 내용을 싣지 않는다.** 내용은 위임받은 쪽이 자기 컨텍스트에서 읽는다. 오케스트레이터 컨텍스트에는 경로 문자열만 남는다.

### P1-a. harnie-reviewer (Claude 코드 리뷰어) — 기준·스키마를 에이전트 본문으로

- `agents/harnie-reviewer.md`(+ko) 본문에 추가: ① `instructions/code-review.md`의 기준 전문 또는 "시작 전 반드시 `${CLAUDE_PLUGIN_ROOT}/instructions/code-review.md`·`verification-tiers.md`·`loop.md`의 출력 스키마 절을 Read하라" 지시, ② VERDICT/ISSUES 출력 스키마 요약. 에이전트 본문은 서브에이전트 시스템 프롬프트로 **결정적 로드**되므로 adherence 손실 없음. (권장: 스키마 요약은 본문 내장, 기준 상세는 Read 지시 — 본문 비대화 방지.)
- 위임 프롬프트는 다음만 전달: 리뷰 단위 디렉터리 경로(`.harnie/.../review/<unit>/`), `delta.patch` **경로**, 이전 ledger **경로**, 스코프/의도 요약 몇 줄. "incremental delta만 리뷰, full re-scan 금지" 문구는 유지(경로로 전달해도 성립).
- 수정 파일: `agents/harnie-reviewer.md`(+ko), `instructions/review-loop-driver.md` R2 Claude 절(L34–36)(+ko), `skills/dev-quick/SKILL.md` Step 6(+ko), `skills/dev-full/SKILL.md` B3/B3′/B5 해당 문구(+ko).

### P1-b. harnie-designer — 프로필 인라인 → 경로 Read 지시

- `design-authoring-{arch,detail}.md` L3의 "The orchestrator injects this file inline"을 "The orchestrator passes this file's absolute path; the designer MUST Read it before writing"으로 변경(+ko). 고도 신호(formal/lightweight)는 프롬프트 문자열로 유지.
- `agents/harnie-designer.md`(+ko)에 "위임 프롬프트가 지정한 authoring profile 파일을 반드시 먼저 Read" 한 줄 추가.
- 수정 파일: 위 2+2, `skills/dev-quick/SKILL.md` Step 3(+ko), `skills/dev-full/SKILL.md` A3/A4/B2′ step 2(+ko).

### P1-c. codex 리뷰어(설계 루프) — 설계 내용 주입 → repo 내 경로

- 설계 산출물은 `.harnie/**` 경로(cwd 안)이므로 codex가 직접 읽을 수 있다. R2 첫 리뷰: 프롬프트에 design 파일 **절대경로** + "먼저 읽어라" 지시. 재리뷰(codex-reply): "rev-N.md를 읽어라 + 변경 섹션명 목록"만.
- 기준(`design-review.md`)은 `developer-instructions`로 **스레드당 1회** 전달 유지(codex-reply 재사용이라 라운드 반복 없음 — 이 비용은 작으므로 굳이 경로화로 도박하지 않는다). §0.1 실측이 성공하면 경로화 가능(선택).
- 수정 파일: `instructions/review-loop-driver.md` R1(L18)·R2 Codex 절(L30–31)·R4(L61)(+ko), `instructions/loop.md` L3(+ko — "inject its contents" 문구를 새 계약으로), `instructions/design-review.md` L29(+ko), `instructions/code-review.md` L30·L34(+ko), `skills/dev-quick/SKILL.md` Step 3 리뷰 절(+ko).

### P1-d. codex 빌더 — plan.md/design.md 내용 주입 → 경로+섹션명

- B2/B2′ step 4, dev-quick Step 4: "the contents of design.md를 포함" → "design.md 절대경로 + 반드시 먼저 읽기" 지시. plan.md 설계 섹션 inline → "plan.md의 `## Architecture`·`## Detailed Design` 섹션을 읽어라".
- `agents/harnie-builder.md`(+ko)에 "프롬프트가 지정한 설계 파일을 구현 전 반드시 읽는다" 추가.
- 수정 파일: `skills/dev-full/SKILL.md` B2·B2′(+ko), `skills/dev-quick/SKILL.md` Step 4(+ko), `agents/harnie-builder.md`(+ko).

### P1-e. 오케스트레이터 Step 0 선로드 축소

- dev-quick Step 0·dev-full Step 0의 "7종 전부 내용 로드"를 다음으로 축소: **오케스트레이터 자신이 실행에 필요한 것만** — `review-loop-driver.md`(배선 매뉴얼)는 유지, `loop.md`는 상태 전이 요약만 필요(전이는 loop.mjs가 결정, 오케스트레이터는 machineState 결과만 소비) → "스키마·상태머신 상세는 읽지 않아도 된다, apply 결과 JSON을 따르라"로 변경. `code-review.md`·`verification-tiers.md`·`design-review.md`·`design-authoring-*`는 위임받는 쪽이 읽으므로 오케스트레이터 선로드 대상에서 제거.
- "Do not restate them here; only orchestrate them" 정신은 유지 — 단일 정보원은 그대로 파일이고, 소비 주체만 위임자로 이동했음을 명시.

## P2 — 위임 응답 길이 계약 (P1과 같은 커밋로 진행)

- 빌더 6-section 응답 계약에 상한 추가: "구현 코드 전문을 응답에 옮기지 말 것(변경은 디스크의 delta로 검증됨). 각 섹션 요약 위주, 전체 응답 ~50줄 이내 목표". `agents/harnie-builder.md`(+ko)와 driver·두 SKILL의 빌더 위임 절에 반영.
- 리뷰어는 이미 VERDICT/ISSUES 스키마로 짧음 — 변경 없음. harnie-scout/designer 반환에도 "재사용될 결론만, 파일 덤프 금지" 한 줄 확인(이미 있으면 유지).

## P3 — dev-full SKILL.md 분할 (P1·P2 후 별도 커밋)

- `skills/dev-full/SKILL.md`를 얇게(목표 ≤12KB): 트랙 개요·불변식·PHASE 라우팅·"각 PHASE 진입 시 아래 파일을 반드시 Read" 지시만.
- 신설: `skills/dev-full/phases/phase-a.md`, `phase-b.md`, `phase-b-parallel.md`(+각 ko). 내용은 현행 본문을 기계적으로 이동(**문구 재작성 최소화** — 12라운드 리뷰를 통과한 계약 문구를 임의로 고치지 않는다). "알려진 의존성" 절은 phase-b-parallel.md로.
- 주의: 스킬 자동 로드는 SKILL.md만이므로 phase 파일 읽기는 지침 의존 — 결정적 게이트(훅)는 영향 없음(수용). frontmatter description 불변(트리거 안정성).
- dev-quick(7.9KB)은 분할 불필요.

## P4 — plan.md 재읽기 축소 (P1에 흡수되는 부분 외 소폭)

- 위임용 재읽기(B2/B2′/B5에 inline하려고 읽던 것)는 P1-d로 소멸. 오케스트레이터 자체 필요분 중 B1 manifest 파싱·B4 스코프 대조·B6 재도출은 유지(정합성 필수·비용 소액). A5 승인 직전 full read 1회 유지.
- SKILL 문구에서 "reread plan.md" 지시 중 위임 준비 목적이던 것만 제거.

## P5 — (선택·별건) PROJECT-STATUS.md 아카이브

- harnie repo **개발 세션**의 상시 37k 토큰 문제. §4 완료 항목·§6 웨이브 로그(~70%)를 `docs/archive/waves-2026-08.md`로 이관, 현행 상태·§7 핸드오프만 유지. 이건 사용자 승인 후 진행(살아있는 허브 문서라 사용자 소유) — 실행 세션은 손대지 말고 제안만 유지.

---

## 실행 순서·커밋 단위

1. **커밋 1 (P1+P2)**: 공유 지침 4종(loop.md L3, review-loop-driver.md, design-review.md, code-review.md, design-authoring 2종, verification-tiers.md L3) + 두 SKILL + 에이전트 3종(reviewer/designer/builder) + **전부 ko 미러**. 한 커밋인 이유: 계약이 절반만 바뀐 상태가 존재하면 안 됨.
2. **커밋 2 (P3)**: dev-full 분할 + ko.
3. **커밋 3 (P4 잔여)**: dev-full/dev-quick의 재읽기 지시 정리 + ko.
4. `.claude-plugin/plugin.json` 버전 범프(설치본 update 반영 — 기존 관례).

## 검증 체크리스트 (실행 세션)

- [x] `node --test scripts/*.test.mjs hooks/*.test.mjs` → **229 pass 유지 확인**(2026-08-18, 커밋 1 P1+P2 적용 후).
- [x] `grep -rn "inject" instructions skills agents` — 남은 것은 의도된 것만: `pr-delivery`·`confluence-doc`의 "caller-injected profile"(범위 밖, 유지), `code-review.md`/`design-review.md`/`review-loop-driver.md`/`design-authoring-arch.md` 안의 "injection"/"fault-injection" 같은 무관한 단어. `harnie-builder.md`의 "the skill injects that contract" 잔존 1건도 이번에 함께 수정(verification-tiers.md 직접 Read로 전환) + ko 미러 동기화 완료.
- [x] EN↔ko 내용 동등성 육안 대조(수정 파일 12쌍 = 24개 전부) — 4개 병렬 Haiku 서브에이전트로 미러 동기화 후 diff 라인 수 일치 확인(스킬 파일 24/18줄, instructions 파일 2/2/4/14줄 등 EN diff와 정확히 일치) + 2개 파일 직접 스팟체크.
- [x] codex `${CLAUDE_PLUGIN_ROOT}` 읽기 실측 1건(§0.1) — **실측 성공**: `cwd=<repo>`, `sandbox:"read-only"`로 repo 밖 절대경로(스크래치패드 프로브 파일)를 codex가 문제없이 Read함(exit 0, sandbox/permission 에러 없음). P1-c 폴백은 불필요하지만, 스레드 재사용 비용이 작다는 원래 판단대로 design-review.md/code-review.md의 codex `developer-instructions` 1회 주입은 그대로 유지.
- [ ] (권장) throwaway repo에서 dev-quick 1회 라이브 스모크 — **미실행**(범위 밖으로 남김, 필요 시 별도 세션에서).
- [x] 커밋 1(P1+P2) 완료.
- [x] **P3 완료**: `skills/dev-full/SKILL.md`(52KB→13.9KB) + `-ko.md`(54KB→14.4KB)를 `skills/dev-full/phases/{phase-a,phase-b,phase-b-parallel}.md`(+각 `-ko.md`)로 분할. 본문은 기계적으로 이동(문구 재작성 최소화), "알려진 의존성" 절은 `phase-b-parallel.md`로. cross-file 참조("below"/"above" 등 위치 참조)만 파일명 참조로 최소 수정. SKILL.md에 "Phase 파일 — 그 phase에 진입할 때 해당 파일만 읽는다" 절 신설. frontmatter description 불변(트리거 안정성). 목표 12KB에 근접(13.9KB, 원본 대비 73% 절감).
- [x] **P4**: B4의 "reread plan.md"는 오케스트레이터 자체 필요(스코프 대조)라 유지 확인 — 추가 정리 대상 없음(P1-d가 위임용 재읽기를 이미 해소).
- [x] `.claude-plugin/plugin.json` 버전 범프: `0.1.1` → `0.1.2`.
- [x] `node --test scripts/*.test.mjs hooks/*.test.mjs` → P3 분할 후에도 **229 pass** 유지 재확인.
- [x] 커밋 2(P3)·커밋 3(P4 잔여) 완료 — `docs/PROJECT-STATUS.md` 갱신은 사용자 확인 후 진행.

### 실행 중 발견한 편차 1건 (기록)
P1-d의 "dev-quick Step 4도 design.md를 경로로 전달" 지시는 dev-full B2(serial)의 "빌더는 `.harnie/`에 접근하면 안 된다" 불변식과 충돌한다 — quick의 Codex 빌더도 `cwd=<repo>` 전체이므로 같은 경계에 걸린다. quick Step 4는 **원래대로 design.md 내용을 inline 유지**하고 이유를 문서에 남겼다(quick의 design.md는 라이트웨이트라 절감 효과도 작음). 반대로 dev-full **B2′(parallel, task worktree)**는 빌더의 `cwd` 자체가 그 태스크의 `.harnie/design/rev-1.md`를 포함하는 격리된 트리이므로 경로 전달로 전환했다.
