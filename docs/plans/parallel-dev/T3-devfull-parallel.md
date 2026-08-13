# T3 — dev-full PHASE B 태스크 병렬화 (R3)

> 이 프롬프트는 자기완결이다. 새 Claude Code 세션(cwd = harnie repo 루트)에 그대로 붙여 실행한다.

## 컨텍스트

- repo: `~/Tradlinx/harnie`. `main` 최신에서 브랜치 `claude/harnie-T3-devfull-parallel` 생성 후 작업.
- 현 dev-full(PHASE A 설계·승인 → PHASE B 실행)의 B1은 태스크를 논리적으로만 fan-out하고, 쓰기는 단일 트리 직렬화 전제다. 목표: **큰 작업일 때 아키텍처 설계 후 서로 겹치지 않는 n개 태스크로 나누고, 태스크별 "상세설계 → 개발 → 코드리뷰"를 worktree 격리로 병렬 수행**, 결과는 run 브랜치로 **순차 merge**(사용자 결정), PR은 run당 1개.
- 병렬 진행 주의: T2 세션이 `scripts/worktree.mjs`를 아래 계약으로 구현 중이다. **이 계약에 대고 문서를 작성**하고, worktree.mjs 자체는 구현·수정하지 않는다.
  - `create --repo <abs> --branch <name> [--from <ref>]` → worktree 경로 stdout (위치 `<repo>/.harnie-wt/<name-sanitized>`)
  - `merge --repo <abs> --branch <name> --into <ref>` → 충돌 시 exit 3 + 충돌 파일 목록
  - `remove --repo <abs> --branch <name> [--keep-branch]`
  - 브랜치 규약: run=`harnie/<slug>`, 태스크=`harnie/<slug>-t<n>`(분기점=run 브랜치)
- T1 세션이 park/lock 토큰/승인 정확바인딩을 제거 중 — 해당 기능을 새로 참조하지 말 것.

## 목표 산출물 (이 태스크는 주로 실행 계약 문서 재작성)

`skills/dev-full/SKILL.md`(+`SKILL-ko.md`), `instructions/review-loop-driver.md`(+`-ko.md`)의 PHASE B 재작성. **엔진(`execution.mjs`·`loop.mjs`) 변경 금지**(T1/T2와 충돌 방지) — 엔진 변경이 불가피해 보이면 구현하지 말고 보고서에 제안으로만 남긴다.

## PHASE B 재설계 사양

### B1 — 분해 (강화)

- manifest의 태스크마다 **파일 스코프(경로 목록/glob)** 를 명시하고, 태스크 간 스코프 교집합이 있으면 분해 실패로 재분해한다(겹침 없는 분해가 병렬성의 전제).
- **경로 선택**: 태스크 1개 또는 총 규모가 작으면 기존 단일-빌더 직렬 경로 그대로(worktree 없음, 현행 유지). 태스크 ≥2이고 스코프가 비겹침이면 병렬 경로.

### B2' — 태스크 병렬 실행 (신설)

태스크별로 (병렬, 동시 ≥3 허용):
1. `worktree.mjs create`로 태스크 worktree 생성(run 브랜치 기준).
2. **태스크 상세설계(경량)**: `harnie-designer` 서브에이전트(read-only)가 run 승인된 plan.md+아키 설계를 입력으로 해당 태스크의 경량 상세설계 산출 → codex 설계리뷰 1라운드(기존 DR 루프 축약형, 경량 고도).
3. **빌드**: codex 빌더(model 오버라이드 가능 시 `gpt-5.6-sol`, `workspace-write`, **cwd=태스크 worktree**)에 상세설계+스코프를 주입해 구현. `loop.mjs capture/delta`는 태스크 worktree를 `<repo>`로 사용.
4. **코드리뷰**: `harnie-reviewer`(read-only, REJECT-bias)가 태스크 delta 리뷰 → REJECT면 codex-reply 수정 루프 → APPROVED. 리뷰 유닛은 태스크 worktree 자체 `.harnie/` 아래(기존 review-unit 스킴 그대로, `--root`=태스크 worktree).

### B3' — 순차 통합 (신설)

- APPROVED된 태스크부터 오케스트레이터가 `worktree.mjs merge`로 run 브랜치에 **순차** merge.
- 충돌(exit 3) 시: 오케스트레이터가 run worktree에서 해결 → **충돌 해결 커밋은 리뷰를 안 거쳤으므로 해결분 delta에 대해 CR 리뷰 1라운드 재실행** → 계속.
- merge 후 태스크 worktree는 `remove --keep-branch`.

### B4~B6 — run 레벨 (기존 계약 유지가 원칙)

- merge 완료된 run worktree 전체에 대해 기존 B3(run 레벨 코드리뷰) 1라운드를 수행하되, 태스크별 승인 이력을 리뷰어에게 제공해 **경량 확인 라운드**로 운영(전면 재리뷰 아님). 이 run 레벨 리뷰 유닛이 기존 completion 재도출 입력을 그대로 충족하므로 **엔진 변경이 필요 없다.**
- B4 verify(manifest 검증 argv)·B5 Final Wave 4게이트·B6 completion은 현행 그대로 run worktree에서.

### 문서화 원칙

- 오케스트레이터가 각 단계에서 실행할 CLI를 기존 문서 스타일(결정적 명령 + 상태 파일 경로)로 명시. 서사적 지시 최소화.
- 과설계 금지: 태스크 스케줄러·의존 그래프 실행기·자동 재시도 등을 만들지 않는다. 의존이 있는 태스크는 "앞 태스크 merge 후 시작"이라는 규칙 한 줄로 처리.

## 검증 (완료 기준)

1. 문서 정합: 재작성된 SKILL.md의 모든 CLI 호출이 실제 스크립트 서브커맨드·인자와 일치(gpt-5.6-luna로 대조 검증).
2. ko 미러 동기(내용 동등성).
3. 데스크 시뮬레이션: 태스크 2개짜리 가상 run의 B1→B2'→B3'→B6 전 단계를 문서만 보고 명령 수준으로 재현한 워크스루를 보고서에 첨부(모호·누락 지점 스스로 발견해 수정).
4. Opus 5 리뷰 APPROVE(관점: 실행 가능성·기존 엔진 계약과의 정합·과설계 여부) 후 커밋(push는 사용자 확인 후).

## 진행 방식·모델 배선 (공통)

- 읽기·조사: codex MCP read-only, model `gpt-5.6-luna`(불가 시 Haiku 서브에이전트).
- 문서 작성: 오케스트레이터(이 세션)가 직접 작성 가능(코드가 아니므로). 코드가 필요해지면 codex `gpt-5.6-sol` workspace-write에 위임.
- 리뷰: Opus 5 read-only 서브에이전트(REJECT-bias).

## 원칙 (전 태스크 공통)

- 요청 범위만 정확히. `commands/`·`scripts/`·`hooks/`는 이 태스크 소유가 아니다(T1/T2 소유).
- 언어 정책: 영문 정본 + `*-ko.md` 미러 동시 갱신.
