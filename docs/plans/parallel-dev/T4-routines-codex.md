# T4 — PR리뷰·배포승인·댓글해결 루틴 4종 Codex 예약작업 이관 (R7)

> 이 프롬프트는 자기완결이다. 새 Claude Code 세션에 그대로 붙여 실행한다. **harnie repo 밖 작업**(홈 디렉터리·`~/Tradlinx` 설정)이며 다른 태스크와 완전 독립.

## 컨텍스트

- 이관 대상(사용자 결정: **4종 전부 일괄 이관**, `~/.claude/scheduled-tasks/` 소재):
  1. `slack-pr-review-autopilot` — 평일 07~20시 15분 주기. `#dev_approval_review`에서 `@dev_be`/`@dev` 멘션 메시지의 ADO PR URL 추출 → Active PR 리뷰(REVIEW 기준, 라인 댓글+투표) / Completed PR 정보성 댓글 → Slack 스레드 회신 → PR worklist 기록.
  2. `qa-deploy-approval-autopilot` — 동일 주기. `#qa-deploy`에서 배포승인 요청 검출 → PR 검토 → 통과 시 봇 ✅ 추가, ✅≥2면 연결 Jira 티켓을 `배포 승인`으로 전이. 봇토큰 파일 사용.
  3. `azdo-pr-comment-resolver` — 동일 주기. worklist의 Active PR에서 본인이 시작한 스레드의 답변/후속 커밋을 검증해 해소된 것만 resolve, 상태 변화 시 재투표.
  4. `azdo-pr-completed-comment-resolver` — 평일 1회. 최근 7일 Completed PR의 미해결 본인 스레드를 증거 기반 resolve. 투표 없음.
- 회사색 config(채널 ID·신원·ADO/Jira 좌표·상태파일 경로·문구·봇토큰 경로)는 `~/Tradlinx/ROUTINE-CONFIG.md`에 통합돼 있고 **그대로 유지·참조**한다. 상태파일(`~/Tradlinx/.routine-state/`)도 그대로 공유(포맷 변경 금지 — 이관 전후 연속성).
- 판단 기준 문서: 루틴들이 읽는 `~/.claude/REVIEW.md`(PR 리뷰 기준). 이관본도 동일 파일을 read하게 한다(경로만 참조, 내용 복제 금지).
- 루틴 로직 자체는 포터블. Claude 종속 = MCP 로딩 방식·지침 파일 경로·"by Claude Code" 풋터 정도.

## 목표

4종 루틴을 **Codex 예약 실행**으로 이관하고, 각 1회 카나리 성공 후 Claude 쪽 루틴을 비활성화한다.

## 진행 순서

### 1. 실행 기반 조사 (추측 금지 — 현물 확인)

- 로컬 `codex` CLI 버전·기능 확인: headless 실행(`codex exec`), config(`~/.codex/config.toml`), MCP 서버 등록 방식, 자체 스케줄/automation 기능 유무.
- **기본 방침(설계 DEC-005)**: 루틴이 로컬 git 클론(`~/Tradlinx/{repo}`)과 로컬 상태파일을 읽어야 하므로 **로컬 `codex exec` + launchd** 를 기본으로 한다. codex에 신뢰할 수 있는 자체 스케줄러가 있으면 그것을 쓰되, 로컬 파일 접근이 보장돼야 한다.
- MCP 필요 목록: Slack, Azure DevOps, Atlassian(Jira). codex config에 등록 가능한지·인증 방식(토큰/OAuth)을 확인하고, **사용자 개입이 필요한 인증은 정확한 절차를 정리해 사용자에게 요청**(자격증명을 직접 입력하지 말 것). 등록 불가한 커넥터가 있으면 해당 루틴은 이관 보류로 보고.

### 2. 루틴 지침 변환

- `~/Tradlinx/routines-codex/<루틴명>.md` 4개 작성: 원 SKILL.md의 절차를 유지하되 ① Claude 전용 표현(ToolSearch·Read/Write 툴명) → codex 환경 대응 표현 ② 풋터 "by Claude Code" → "by Codex"(AI 리뷰 고지 문구는 유지) ③ 회사색 값은 인라인하지 말고 `ROUTINE-CONFIG.md` 읽기 지시 유지 ④ 멱등성 규칙(기존 댓글/✅/마커 dedupe)은 특히 그대로 보존.
- 각 지침에 **dry-run 모드 절**을 넣는다: 환경변수 또는 프롬프트 플래그로 "판단까지 수행, 외부 쓰기(댓글·투표·리액션·Jira 전이·Slack 회신) 직전에 중단하고 수행 예정 목록만 출력".

### 3. 스케줄 등록

- launchd plist(또는 1에서 확인된 codex 스케줄러) 4개: 기존과 동일 주기(15분 3종 = 평일 07:00–20:00, completed-resolver 1종 = 평일 1회 — **원문에 17시/19시 불일치가 있으니 사용자에게 확정 질문**). 로그는 `~/Tradlinx/.routine-state/logs/`에.

### 4. 카나리 → 전환

- 루틴별 dry-run 1회 수동 실행 → 수행 예정 목록이 기존 루틴의 판단과 동등한지 확인해 보고.
- **외부 쓰기가 있는 라이브 전환은 루틴별로 사용자 확인을 받은 뒤** 실행. 라이브 1회 성공 확인 후 해당 Claude 루틴 비활성화(`~/.claude/scheduled-tasks/`의 해당 루틴 — 삭제하지 말고 비활성 처리/이동, 롤백 대비 2주 보존).

## 완료 기준

1. 4종 지침 변환본 + 스케줄 등록 + dry-run 카나리 결과 보고.
2. 사용자 확인 받은 루틴부터 라이브 전환·Claude 루틴 비활성화.
3. 보고서: 커넥터/인증 상태, 이관 보류 루틴과 사유, 롤백 방법 한 단락.

## 주의·원칙

- **외부 부수효과 주의**: 카나리든 뭐든 실제 Slack/ADO/Jira에 쓰는 동작은 사용자 확인 없이 실행하지 않는다.
- 봇토큰·자격증명은 경로 참조만, 값을 출력·복사하지 않는다.
- 과설계 금지: 재시도 프레임워크·모니터링 대시보드 등 만들지 않는다. 실패는 로그+다음 주기 재실행으로 충분.
- 읽기·조사는 codex read-only(model `gpt-5.6-luna`) 또는 Haiku 서브에이전트로 위임해 토큰 절약.
