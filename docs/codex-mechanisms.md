# Codex 메커니즘 — 확정 사실 (재현 가능)

체인 스킬과 그 리뷰 세션이 의존하는 Codex 측 메커니즘의 **확정 사실**. 실측은 재현 명령과 함께 적고, 공식 문서 근거는 URL을 남긴다. 폐기된 구조(MCP 리뷰 루프·run-state 훅·에이전트)의 실측은 git 히스토리에 있다.

## Codex 훅 — 페이로드 실측 (2026-08-31, codex-cli 0.144.4)

플러그인의 `hooks/hooks.json`은 Codex도 로드한다. 실행 사본은 `~/.codex/plugins/cache/harnie/harnie/<version>`이며, 버전 고정과 업그레이드가 그 사본을 지우는 문제는 `CLAUDE.md` §릴리스 후속이 다룬다.

**재현**: 훅 스크립트의 stdin 처리부에 원문을 파일로 append하는 한 줄을 임시로 넣고 `codex -a never exec --sandbox read-only --skip-git-repo-check -m gpt-5.6-terra -C <dir> "echo probe-a && echo probe-b 하나만 실행하라"`를 돌린 뒤 원본으로 복원한다. `hooks.json`의 커맨드 문자열을 건드리지 않으므로 훅 신뢰 해시 재승인이 필요 없다.

**PreToolUse 페이로드**(셸 명령 1건):

```json
{ "session_id": "…", "turn_id": "…", "transcript_path": "…/rollout-….jsonl",
  "cwd": "<workdir>", "hook_event_name": "PreToolUse",
  "model": "gpt-5.6-terra", "permission_mode": "bypassPermissions",
  "tool_name": "Bash", "tool_input": { "command": "echo probe-a && echo probe-b" },
  "tool_use_id": "exec-…" }
```

**Stop 페이로드**: 위 공통 필드에 `stop_hook_active`(bool)와 `last_assistant_message`(string)가 붙는다.

- **셸 도구의 `tool_name`은 `Bash`이고 `tool_input.command`는 문자열이다**(`shell`도 배열도 아니다). Claude와 같은 형태이므로 `toolName === "Bash"` 분기와 문자열 파싱 가드가 Codex에서 그대로 발화한다.
- **`permission_mode`는 `-a never`에서 `bypassPermissions`로 온다.** 런타임 판별에는 쓰지 않는다 — 판별자는 `turn_id`의 존재다(Claude 페이로드에는 없다).
- **deny가 실제로 명령을 막는다.** 전역 bash-guard의 복합 명령 deny에 Codex가 `error=Command blocked by PreToolUse hook: …` + `hook: PreToolUse Blocked`로 반응하고 명령을 실행하지 않았다. 훅 출력 계약(`permissionDecision: "deny"`)이 Codex에서 유효하다.
- **헤드리스에서도 돈다.** 같은 실행에서 PreToolUse 훅 3개(bash-guard · orca · harnie)가 모두 발화했다. `claude -p`가 MCP를 로드하지 않는 제약과 달리, `codex exec`의 훅에는 그런 제약이 없다.

## effort 오버라이드 실측 (2026-08-26)

- Codex MCP 호출부(`mcp__codex__codex`)는 `config: {model_reasoning_effort: "high"}`로 **호출 스코프 reasoning effort**를 줄 수 있다. 키 이름 `model_reasoning_effort`의 오타는 Codex가 **무음으로 무시**하므로 철자가 중요하다. CLI는 `-c model_reasoning_effort="xhigh"`로 같은 값을 받는다(2026-09-08 orca 세션에서 `xhigh` 확인).
- Agent 툴로 디스패치되는 Claude 서브에이전트에는 effort 필드가 **없다**(부재 확인). 그래서 Claude 쪽 very-hard 티어는 effort가 아니라 **모델 승급**으로만 표현된다.
- 검증 출처: `~/Tradlinx/task2-recovery/effort-e2e.md`(정리 대상이면 이 항목만 남는다).

## Codex 훅 이벤트 전체와 스킬 호출의 관측 불가 (2026-09-08 조사, codex-cli 0.153.4)

공식 훅 이벤트는 12개다: `PreToolUse` · `PermissionRequest` · `PostToolUse` · `PreCompact` · `PostCompact` · `UserPromptSubmit` · `SubagentStart` · `SubagentStop` · `Stop` · `Interrupt` · `SessionStart` · `SessionEnd`. `Interrupt`와 `SessionEnd`는 subagent에 발화하지 않는다. 사용자·저장소·플러그인 훅은 대체가 아니라 전부 실행된다.

**공식 계약에 스킬 호출을 잡는 이벤트나 필드는 없다.** `PreToolUse`의 canonical 도구는 `Bash`·`apply_patch`·MCP·local function tool이고 `Skill` 도구가 문서에 없다. 관측 범위는 둘로 갈린다. `$name` 직접 입력은 `UserPromptSubmit.prompt` 원문에 실리고 그 훅은 prompt를 차단할 수 있으므로 텍스트 매칭으로 막는 경로는 열려 있다(실행 검증은 안 했다). description 자동 매칭은 어느 훅에도 안정된 필드로 남는다는 계약이 없다(마찬가지로 실행 미검증). 문서화된 비활성 수단은 `config.toml`의 `[[skills.config]] path=… enabled=false`(파일 단위)와 스킬 `openai.yaml`의 `policy.allow_implicit_invocation: false`(암시 호출만 차단)다. 같은 `name`의 스킬 둘은 병합되지 않고 selector에 둘 다 뜬다(우선순위 규칙 없음).

Claude Code 쪽 대응물(비교용): `permissions.deny`에 `Skill(name)`·`Skill(name *)` 지원(deny > ask > allow), 모델 호출은 `PreToolUse` matcher `Skill`, 사용자 직접 `/name`은 `UserPromptExpansion`(`command_name`·`command_source`, `decision:"block"`)이 받는다. 번들 전체 off는 `disableBundledSkills`, 개별은 `skillOverrides: off`. `tool_input.skill` 키는 공식 스키마가 보장하지 않는다(이전 harnie 훅이 실측으로 썼다).

**에이전트는 공용 불가.** Codex 커스텀 에이전트는 `~/.codex/agents/*.toml`·`.codex/agents/*.toml`, 필수 `name`·`description`·`developer_instructions`, 선택 `model`·`model_reasoning_effort`·`sandbox_mode`·`mcp_servers`·`skills.config`. `tools` 필드가 없고 도구 표면은 sandbox로 제어한다. 내장은 `default`·`worker`·`explorer`(읽기 중심). **Codex 플러그인 구성요소는 skills + MCP server뿐이라 에이전트를 배포하지 못한다.** 읽기 전용 탐색은 양쪽 내장(`Explore` / `explorer`)이 이미 있다. 외부 레퍼런스 조사용 에이전트는 두지 않는다(2026-09-09 검토 후 제외) — 설계 세션이 직접 찾고, 큰 조사는 orca로 luna 세션을 연다. 웹이 필요한 Codex 세션은 `workspace-write`여야 한다(전역 `[sandbox_workspace_write] network_access = true`가 네트워크를 켠다; read-only에서 웹 검색이 되는지는 `[미확인]`).

**스킬 본문 크기.** 공식 문서상 8,000자는 선택 전 initial skills list 예산(컨텍스트 2% 또는 8,000자)이고, 선택되면 `SKILL.md` 전체를 읽는다. 설치 바이너리 `strings`에 `MAX_SKILL_PROMPT_BYTES`가 없고 system skill도 19KB 파일을 포함한다(2026-09-08 조사). 별도 실행 실측 하나가 이와 일치한다 — 2026-09-08 Codex에서 플러그인 스킬 `implementation-review`(24,929바이트)를 호출시켜 주입된 지침의 꼬리 200자를 인용하게 하니 파일 끝과 정확히 일치했다. 계측 한계: 파일을 읽지 말라고 지시했으나 실제로 안 읽었는지는 검증하지 못했다.

**샌드박스와 쓰기 범위 (2026-09-08 조사).** `--sandbox read-only`는 쓰기 예외가 없다(결과 파일도 못 쓴다). `workspace-write`는 workspace 전체가 쓰기 가능하고 파일별 allowlist가 없으며, `-C <dir>`는 working root 지정이지 쓰기 루트를 그 디렉터리로 한정한다는 공식 보장이 없다. `sandbox_workspace_write.writable_roots`는 쓰기 위치를 넓히는 설정이다. 또 `workspace-write`는 `.git/` 아래 쓰기를 거부하므로 `-a never` 세션은 커밋할 수 없다(2026-08-31 실측). 그래서 체인 리뷰어 세션은 `workspace-write`로 열고 "결과 파일만 쓴다"는 스킬 규칙에 의존한다(`docs/design-artifact-references.md` §14).

출처: https://developers.openai.com/codex/hooks · https://developers.openai.com/codex/skills · https://developers.openai.com/codex/subagents · https://developers.openai.com/codex/sandboxing · https://developers.openai.com/plugins/concepts/plugins · https://code.claude.com/docs/en/skills · https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/permissions · https://code.claude.com/docs/en/sub-agents
