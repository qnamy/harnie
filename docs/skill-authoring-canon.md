# 스킬·지침 작성 규약의 근거 (Claude · Codex 공용)

> 조사일 2026-09-03. `CLAUDE.md` / `AGENTS.md` §"스킬·지침 작성 규약"의 근거다. 규약 자체는 그쪽이 정본이고 이 문서는 출처와 수치를 보관한다.

## 1. 공식이 낸 유일한 하드 숫자

| 항목 | 수치 | 출처 |
|---|---|---|
| SKILL.md 본문 상한 | **500줄 / 5,000토큰 미만** | Anthropic best-practices, agentskills.io 양쪽 동일 |
| 메타데이터 상주 비용 | 스킬당 **~100토큰**(name + description) | Agent Skills overview |
| 번들 파일 비용 | 열기 전까지 **0** | 동일 |
| `description` 길이 | 1,024자(중립 스펙) / Claude Code 목록에서 description+when_to_use 합산 **1,536자** 캡, 초과분 절단 | agentskills.io, Claude Code frontmatter 레퍼런스 |
| Codex 스킬 선택기 목록 | 컨텍스트의 **2%**(윈도 미상이면 8,000자) | learn.chatgpt.com/docs/build-skills |
| Codex AGENTS.md 인제스트 | **32 KiB**(`project_doc_max_bytes`) | Codex agents-md 문서 |
| Claude Code 압축 후 재부착 | 스킬당 앞 **5,000토큰**, 전체 **25,000토큰** 예산 | Claude Code skills 레퍼런스 |

참조 파일은 **SKILL.md에서 한 단계 깊이까지만** 둔다. 중첩하면(SKILL.md → advanced.md → details.md) Claude가 `head -100`으로 부분만 읽어 정보가 잘린다. 100줄 넘는 참조 파일에는 목차를 단다.

## 2. 길이가 준수율을 깎는다는 측정

벤더는 "최적 길이" 숫자를 낸 적이 없다. Anthropic은 정성 서술뿐이다. *"Bloated CLAUDE.md files cause Claude to ignore your actual instructions."* 대신 **동시 지시 개수** 축에 측정이 있다.

- IFScale (arXiv 2507.11538): 지시 500개에서 최상위 모델도 정확도 68%에 머물고 점진 저하하며, 앞쪽 위치 편향이 있다.
- Prompt Design at Scale (arXiv 2607.19257): 동시 지시 80개에서 완전준수율이 사실상 0%로 무너진다(Claude Haiku 85% → 0%, N=10 → N=80).
- Lost in the Middle (Liu et al., arXiv 2307.03172, TACL): 관련 정보가 중간에 있으면 앞·뒤 배치 대비 성능이 30% 이상 떨어진다.

따라서 관리해야 할 값은 줄 수가 아니라 **뚜렷한 MUST 규칙 개수**이고, 임계 규칙은 문서 앞과 뒤에 둔다.

**마크다운 구조가 준수율을 높인다는 증거는 없다.** 같은 Prompt Design at Scale이 마크다운 대 평문 차이를 −4.8 ~ +2.3%p로 측정했다(한 모델은 마크다운에서 더 나빴다). 체크리스트가 산문보다 낫다는 측정(arXiv 2605.20149, 7.50/8 대 5.67/8)은 지시 준수가 아니라 산출물 품질을 잰 것이다. 표는 준수율 목적이 아니라 내용이 실제로 표일 때만 쓴다.

## 3. 이식성 — 실제로 옮겨지는 것

Agent Skills는 벤더 중립 표준(agentskills.io)이고 Codex도 같은 `SKILL.md` + `name`/`description`을 읽는다. **이식되는 건 본문과 이 두 필드뿐이다.**

| 축 | Claude Code | Codex | 공용 규칙 |
|---|---|---|---|
| 확장 프론트매터 | `context: fork`, `agent`, `hooks`, `model`, `allowed-tools`, `argument-hint` 등 | 문서화된 수용 필드 없음, 조용히 무시 | 쓰지 않는다 |
| 경로 변수 | `${CLAUDE_PLUGIN_ROOT}` | 대응물 없음 | 스킬 루트 기준 상대 경로만 |
| 호출 문법 | `/name` | `$name`(CLI·IDE), `@name`(ChatGPT 데스크톱) | 본문 산문에 호출 문법을 쓰지 않는다 |
| 스킬 디렉터리 | 플러그인 `skills/`, 프로젝트 `.claude/skills/` | `.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills` | 양쪽에 물리적으로 존재해야 한다 |
| 웹 조사 | `WebSearch` + `WebFetch`(전체 페이지) | 내장 검색 기본 `cached` 모드, **스니펫만**. 전체 페이지 fetch 대응물 없음(MCP로만). 샌드박스 네트워크는 `workspace-write`에서도 기본 off | 조사 능력을 전제하지 않는다 |
| 서브에이전트 | Task/Agent 도구, 모델 자율 디스패치 | TOML 정의(`~/.codex/agents/`), 내장 `explorer`, **위임 기본 수동**(자율은 상위 티어만) | "스킬이 서브에이전트를 띄운다"를 계약으로 못 박지 않는다 |
| 도구 이름 | `Read`·`Grep`·`Bash` 등 | 다른 표면 | 본문에 도구 이름을 쓰지 않는다 |
| 마크다운 본문 | 제약 없음 | 제약 없음 | 유일하게 비호환이 확인되지 않은 축 |

`allowed-tools`는 중립 스펙 본문이 스스로 실험적이라고 표기하고("support for this field may vary between agent implementations"), Claude Code Agent SDK에서는 아예 적용되지 않는다. 강제 수단으로 쓰지 않는다.

## 4. 작성 스타일 — 공식이 명시한 것

- `description`은 **3인칭**으로 무엇을·언제 쓸지 모두 적는다. *"Good: 'Processes Excel files and generates reports' / Avoid: 'I can help you...'"* 앞부분이 절단되므로 핵심 유스케이스를 먼저 둔다. 공식 `docx` 스킬은 부정 스코프까지 넣는다. *"Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."*
- **자유도를 작업 취약성에 맞춘다.** 판단이 필요한 곳은 산문 휴리스틱(고자유도), 틀리면 비싼 곳은 "정확히 이 절차, 플래그 추가 금지"(저자유도).
- 왜가 아니라 무엇을 적는다. *"State what to do rather than narrating how or why."*
- 유효한 선택지를 여러 개 나열하지 않는다. 기본 하나와 탈출구 하나.
- 시점 의존 문장("2025년 8월 이전이면 구 API 사용")을 넣지 않는다. 한 개념에는 한 용어만 쓴다. 경로는 항상 슬래시.
- **배포할 모든 모델로 테스트한다.** Haiku(지침이 충분한가) / Sonnet(명확·효율적인가) / Opus(과설명 아닌가).
- Claude Code는 스킬 본문을 **한 번 주입하면 이후 턴에 다시 읽지 않는다.** 지침은 1회 절차가 아니라 상주 규칙 문장으로 써야 남는다.
- GPT-5 프롬프팅 가이드: **모호하거나 상충하는 지침은 GPT-5에 더 해롭다.** 공용 본문에 한쪽 모델이 알아서 메울 모순을 남기면 다른 쪽에서 사고가 된다.

공식 스킬 실물(`anthropics/skills`의 `pdf`, `docx`)의 공통 형태 — 결정 테이블을 코드보다 먼저, gotcha는 한 줄씩, 산출물 검증 절차를 본문에 박음, 사용자에게 인라인 질문 안 함, 엣지케이스만 참조 파일로 미룸.

## 5. 스킬 체이닝은 문서화되지 않았다

Anthropic 공식 언급은 "Compose capabilities: Combine Skills for complex, multistep tasks." 한 줄뿐이다. `/a /b` 스태킹은 **지침 동시 로드**이지 출력 파이프가 아니다(첫 스킬 + 최대 5개, 인라인 호출 불가 스킬에서 중단). 즉 요구사항 → 설계 → 설계리뷰 → 개발 연결은 **약속된 파일 경로 규약**으로 우리가 정하는 수밖에 없다. 이건 추론이고 공식 규약이 아니다.

## 출처

- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- https://code.claude.com/docs/en/skills.md · https://code.claude.com/docs/en/best-practices
- https://agentskills.io/specification
- https://learn.chatgpt.com/docs/build-skills · https://learn.chatgpt.com/docs/sandboxing · https://learn.chatgpt.com/docs/agent-configuration/subagents · https://learn.chatgpt.com/docs/agent-configuration/agents-md
- https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide
- https://github.com/anthropics/skills (`skills/pdf/SKILL.md`, `skills/docx/SKILL.md`)
- arXiv 2507.11538 · arXiv 2607.19257 · arXiv 2307.03172 · arXiv 2605.20149
