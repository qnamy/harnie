// harnie 강제 훅의 **순수 결정 함수**(IO 없음). 훅 엔트리 스크립트가 세션 상태를 해석해 넘기면
// 여기서 allow/deny·block/pass를 계산한다. 설계: docs/EXECUTION-STATE-DESIGN.md §5.
// 위협모델 §0.1 — fallible·over-eager 오케스트레이터/빌더의 **실수**를 막는다(적대적 완전봉쇄 비목표).
import { resolve, relative, isAbsolute } from "node:path"

// ── 경로 분류 ────────────────────────────────────────────────────────────
// relPath = repo root 기준 상대(posix). **권위(authority) 파일**만 직접 쓰기 금지 — 기록은 execution.mjs·loop.mjs로만.
// round-N.txt·delta.patch·design.md·notepad.md·plan.md은 권위가 아니라 오케스트레이터/loop의 정당한 산출물이므로 허용
// (plan.md는 승인 前 phase 게이트가, delta.patch는 loop.mjs가 소유). ledger·state·receipt·manifest·execution·sentinel·seal·pending·arm만 control.
const CONTROL_BASENAMES = new Set([
  "manifest.json", "execution.json", "active.json", "ledger.json", "state.json", "receipt.json",
  ".seal.json", ".pending-approval.json", ".arm-approval.json",
])
// case-insensitive FS(macOS 기본)에서 `.HARNIE`·`MANIFEST.JSON`로 우회하지 못하게 소문자 정규화 후 비교.
export function isControlPath(relPath) {
  const p = String(relPath).replace(/\\/g, "/").toLowerCase()
  if (!p.startsWith(".harnie/")) return false
  return CONTROL_BASENAMES.has(p.split("/").pop())
}

const PLANNING_PHASES = new Set(["planning", "awaiting-approval"])

// ── H1: Write|Edit ──────────────────────────────────────────────────────
// 1) control·review-state 직접 쓰기는 phase 무관 deny. 2) 승인 前(planning/awaiting)엔 `.harnie/<track>/<slug>/` 밖 전부 deny.
export function decideWriteEdit({ relPath, phase, track, slug }) {
  const p = String(relPath).replace(/\\/g, "/")
  if (isControlPath(p))
    return { deny: true, reason: `control·review-state 직접 쓰기 금지(${p}) — 기록은 execution.mjs·loop.mjs로만` }
  if (PLANNING_PHASES.has(phase)) {
    const allowed = `.harnie/${track}/${slug}/`
    if (!p.startsWith(allowed))
      return { deny: true, reason: `승인 前(${phase}) 소스 쓰기 금지 — ${allowed} 밖(${p})은 승인 게이트 후에만` }
  }
  return { deny: false }
}

// ── H1: Bash ────────────────────────────────────────────────────────────
// sanctioned CLI(node …/loop.mjs·execution.mjs, 셸 연산자·리다이렉트 없음)만 예외 — 단, 그 CLI 자체가
// output/ledger/state 경로를 `.harnie/` 안으로 검증하므로 임의 경로 쓰기 primitive가 되지 않는다.
// 항상: .harnie 변형 deny. **승인 前(planning/awaiting): read-only 명령·sanctioned CLI만 allow**(§5.1 allowlist,
// git apply·npm·인터프리터·리다이렉트 등 모든 쓰기·부작용 fail-closed).
// 셸 메타 — 연쇄·서브셸·리다이렉트·**프로세스 치환·개행**까지. read-only 판정에서 파이프(|)는 세그먼트별로 따로 검사.
const SHELL_HARD = /[;&`\n\r]|\$\(|<\(|>\(|[<>]/ // read-only에서 즉시 거부(파이프 제외)
const SHELL_ANY = /[;|&`\n\r]|\$\(|<\(|>\(|[<>]/ // sanctioned CLI는 파이프 포함 어떤 메타도 불가
const HARNIE_REF = /\.harnie\b/i                 // 비-sanctioned Bash의 .harnie 접근 차단(case-insensitive FS의 .HARNIE 포함)
// 승인 前 허용하는 read-only 명령. 쓰기 옵션 있는 명령(find/sort/yq)은 제외하고 WRITE_FLAG 토큰도 거부.
const RO_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "echo", "which", "type",
  "file", "stat", "tree", "dirname", "basename", "realpath", "readlink", "uniq", "cut", "comm",
  "column", "jq", "diff", "cmp", "date", "printenv", "hostname", "whoami", "uname", "du", "df", "test", "nl", "fold",
])
const GIT_RO = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "cat-file", "blame", "describe",
  "shortlog", "merge-base", "name-rev", "symbolic-ref", "for-each-ref", "show-ref", "rev-list",
])
const WRITE_FLAG = /^(--output(=.*)?|--out(=.*)?|-delete|--delete|-exec|-execdir|-ok|--in-place|--inplace|-fprint.*|-fls)$/
// 개행·서브셸·리다이렉트·프로세스치환 없이, 파이프 각 세그먼트의 선두가 read-only(또는 안전한 git 하위명령)이고 쓰기 옵션이 없는지.
function isReadOnlyBash(cmd) {
  if (SHELL_HARD.test(cmd)) return false // 개행·연쇄·서브셸·리다이렉트·프로세스치환 금지
  for (const seg of cmd.split("|")) {
    const toks = seg.trim().split(/\s+/)
    const base = (toks[0] || "").split("/").pop()
    if (base === "git") { if (!GIT_RO.has(toks[1])) return false }
    else if (!RO_CMDS.has(base)) return false
    if (toks.some((t) => WRITE_FLAG.test(t))) return false
  }
  return true
}
// sanctioned 상태 CLI 판별: `node <script> …`에서 <script>가 **신뢰 CLI 경로와 정확 일치**하고, 어떤 셸 메타도 없고,
// **서브커맨드별 argv가 현재 active context(root·slug·track·positional repo·출력경로)에 정확히 바인딩**될 때만.
// (다른 repo·stale slug 타겟 차단 — 특히 execution.mjs verify가 과거 manifest의 executable을 승인 前 실행하는 것 방지.)
function isSanctionedCli(cmd, { trustedClis, activeRoot, activeSlug, activeTrack, trustedNode = null }) {
  if (SHELL_ANY.test(cmd)) return false
  const toks = cmd.trim().split(/\s+/)
  // 인터프리터 바인딩(DR-004): bare `node`(PATH의 세션 node) 또는 신뢰 절대경로(process.execPath)만.
  // `/tmp/node`·`./node` 같은 경로지정 위장 인터프리터는 신뢰 스크립트를 무시하고 임의 실행할 수 있어 거부.
  const exe = toks[0] || ""
  if (exe !== "node" && !(trustedNode != null && resolve(exe) === trustedNode)) return false
  const scriptAbs = toks[1] ? resolve(toks[1]) : ""
  if (!trustedClis.has(scriptAbs)) return false
  if (activeRoot == null) return true // 바인딩 컨텍스트 없음(테스트 등)
  const ar = resolve(activeRoot)
  const rest = toks.slice(2)
  // **중복 플래그 거부**: 가드는 indexOf(첫 값)로 보지만 CLI parseArgs는 last-wins라, `--root /repo … --root /other`로
  // 우회 가능. 같은 플래그가 두 번 나오면 sanctioned 아님(CLI도 parseArgs에서 dup을 fail-closed).
  const flagToks = rest.filter((t) => t.startsWith("--"))
  if (new Set(flagToks).size !== flagToks.length) return false
  const flagVal = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
  const isRepo = (v) => v !== undefined && resolve(ar, v) === ar
  if (scriptAbs.endsWith("execution.mjs")) {
    if (!isRepo(flagVal("--root"))) return false                  // --root === active repo
    if (flagVal("--slug") !== activeSlug) return false            // --slug === active slug(stale slug 차단)
    const tk = flagVal("--track"); if ((tk === undefined ? "plan" : tk) !== activeTrack) return false // 생략=plan(execution 기본)로 간주해 track 정확 바인딩(CR-002)
    return true
  }
  if (scriptAbs.endsWith("loop.mjs")) {
    const sub = rest[0]
    if ((sub === "capture" || sub === "delta") && !isRepo(rest[1])) return false // positional repo === active repo
    // loop 출력·상태 경로는 **active review 디렉터리** 아래로 바인딩(다른 slug/track·외부 .harnie 차단).
    const reviewRoot = activeTrack && activeSlug ? resolve(ar, ".harnie", activeTrack, activeSlug, "review") : resolve(ar, ".harnie")
    const underReview = (v) => { if (v === undefined) return true; const rel = relative(reviewRoot, resolve(ar, v)); return !rel.startsWith("..") && !isAbsolute(rel) }
    if (!underReview(flagVal("--out")) || !underReview(flagVal("--ledger")) || !underReview(flagVal("--state"))) return false
    if (sub === "apply" && !isRepo(flagVal("--root"))) return false // apply의 --root === active repo(loop.mjs가 containment 재검증)
    return true
  }
  return false
}
// auto-allow 대상 sanctioned 서브커맨드(명시 allowlist) — 효과가 제한된 4종만. isSanctionedCli의 넓은
// 결과를 그대로 auto-allow하지 않는다: 그건 apply·verify·seal·init·set-task 등 상태 변경 서브커맨드도
// 정상으로 판정하므로, 여기서 **서브커맨드를 명시적으로 4종으로 좁혀** 프롬프트 skip 대상을 한정한다.
//   loop.mjs: capture(임시 index+tree object 생성, worktree 불변), delta(.harnie 하위 delta.patch만 write)
//   execution.mjs: completion(재도출 read-only), seal-verify(재해시 비교 read-only)
// apply(ledger/state 전이)·verify(receipt+argv 실행)·seal(baseline 재기록)·상태변경 execution·codex는 auto-allow 제외.
const AUTO_ALLOW_SUB = { "loop.mjs": new Set(["capture", "delta"]), "execution.mjs": new Set(["completion", "seal-verify"]) }
// auto-allow는 **유효한 완전 active context**를 전제(CR-001). null뿐 아니라 빈 문자열·공백 slug(failClosed의 " ")·
// 규약 밖 track도 거부한다. slug는 execution.mjs와 동일 형식, track은 plan|quick만.
const SLUG_RE = /^[A-Za-z0-9._-]+$/
function hasValidActiveContext(root, slug, track) {
  if (typeof root !== "string" || root.length === 0) return false
  if (typeof slug !== "string" || !SLUG_RE.test(slug) || slug === "." || slug === "..") return false
  return track === "plan" || track === "quick"
}
function isAutoAllowSanctionedSub(cmd) {
  const toks = cmd.trim().split(/\s+/)
  const script = toks[1] || ""
  const sub = toks[2] // 서브커맨드는 항상 스크립트 바로 뒤 첫 토큰(비정상 순서면 미허용 → 프롬프트, 안전 기본값)
  if (sub == null || sub.startsWith("--")) return false
  for (const [name, subs] of Object.entries(AUTO_ALLOW_SUB)) if (script.endsWith(name) && subs.has(sub)) return true
  return false
}
// trustedClis = 플러그인의 loop.mjs·execution.mjs 절대경로 Set. active{Root,Slug,Track} = 현재 활성 컨텍스트(훅이 주입).
// trustedNode = process.execPath(훅 주입) — 인터프리터 바인딩용. 반환 autoAllow=true면 훅이 PreToolUse allow(프롬프트 skip).
export function decideBash({ command, phase, trustedClis = new Set(), activeRoot = null, activeSlug = null, activeTrack = null, trustedNode = null }) {
  const cmd = String(command || "")
  if (isSanctionedCli(cmd, { trustedClis, activeRoot, activeSlug, activeTrack, trustedNode })) {
    // auto-allow는 **유효한 완전 active 바인딩** 전제(root·slug·track). isSanctionedCli의 activeRoot==null
    // 호환 경로나 빈/규약밖 컨텍스트에선 바인딩 검증이 무력하므로 auto-allow 금지 — 그땐 프롬프트(CR-001).
    const bound = hasValidActiveContext(activeRoot, activeSlug, activeTrack)
    return { deny: false, autoAllow: bound && isAutoAllowSanctionedSub(cmd) } // sanctioned은 통과; 그 중 4종·유효바인딩만 auto-allow
  }
  // 비-sanctioned Bash의 .harnie 접근은 phase 무관 전면 차단(승인 후 find .harnie -delete·git clean·node -e 등 포함).
  if (HARNIE_REF.test(cmd))
    return { deny: true, reason: `Bash로 .harnie 접근 금지 — 상태는 loop.mjs·execution.mjs(신뢰 CLI)로만` }
  if (PLANNING_PHASES.has(phase)) {
    if (isReadOnlyBash(cmd)) return { deny: false, autoAllow: false } // read-only는 허용하되 auto-allow 범위 확대 안 함(프롬프트 유지)
    return { deny: true, reason: `승인 前(${phase}) Bash는 read-only 명령·신뢰 CLI만 — 파일 쓰기·개행연쇄·프로세스치환·git 변경·임의 실행은 승인 게이트 후에만` }
  }
  return { deny: false, autoAllow: false } // 승인 후: 소스 쓰기 허용(.harnie는 위에서 전면 차단). 자동허용은 sanctioned 4종만.
}

// ── H1: Task(서브에이전트 위임) ─────────────────────────────────────────
// 승인 前엔 write 가능 서브에이전트 위임 금지(read-only만).
// designer(Read/Grep/Glob/WebFetch/WebSearch)는 read-only — 설계 산출물은 텍스트로 반환하고 파일은 main이 쓴다.
const READONLY_AGENTS = new Set(["harnie-scout", "harnie-reviewer", "harnie-designer", "Explore", "Plan"])
export function decideTask({ subagentType, phase }) {
  if (PLANNING_PHASES.has(phase) && !READONLY_AGENTS.has(subagentType))
    return { deny: true, reason: `승인 前(${phase})엔 read-only 서브에이전트만 위임 가능(${subagentType} 차단) — 코드 작성은 승인 후` }
  return { deny: false }
}

// ── H1: Codex MCP ───────────────────────────────────────────────────────
// planning/awaiting: codex는 read-only만; codex-reply는 등록된 read-only 스레드만.
// executing/final-wave: workspace-write codex 부트스트랩 허용(1회 최초 호출은 PostToolUse가 threadId 등록);
//   codex-reply는 등록된 스레드(빌더 or read-only)만.
export function decideCodex({ isReply, sandbox, cwd, root, threadId, phase, readOnlyThreads = [], builderThreads = [], hasBuildingUnbound = false }) {
  const registered = new Set([...readOnlyThreads, ...builderThreads])
  if (PLANNING_PHASES.has(phase)) {
    if (!isReply) {
      if (sandbox !== "read-only")
        return { deny: true, reason: `승인 前(${phase}) codex는 sandbox:"read-only"만(설계 리뷰) — ${JSON.stringify(sandbox)} 차단` }
      return { deny: false }
    }
    if (!readOnlyThreads.includes(threadId))
      return { deny: true, reason: `승인 前 codex-reply는 등록된 read-only 스레드만(${threadId} 미등록)` }
    return { deny: false }
  }
  // executing / final-wave
  if (!isReply) {
    if (sandbox === "read-only") return { deny: false } // read-only 리뷰(예: 최종 사인오프)
    // 빌더 부트스트랩: **정확히 workspace-write** + cwd가 활성 repo root + building·미바인딩 task가 있을 때만.
    if (sandbox !== "workspace-write")
      return { deny: true, reason: `빌더 codex sandbox는 정확히 "workspace-write"만(${JSON.stringify(sandbox)} 차단 — danger-full-access·미지정 불가)` }
    // cwd는 **필수**이며 정확히 활성 repo root여야 함(미지정도 deny — 임의/상위 디렉터리 쓰기 차단).
    if (cwd == null || root == null || cwd !== root)
      return { deny: true, reason: `빌더 codex cwd는 활성 repo root로 명시돼야 함(got ${JSON.stringify(cwd)}, expect ${JSON.stringify(root)})` }
    if (!hasBuildingUnbound)
      return { deny: true, reason: `빌더 workspace-write 호출은 building·미바인딩 task가 있을 때만(set-task로 표시 후) — 임의 쓰기 차단` }
    return { deny: false }
  }
  if (!registered.has(threadId))
    return { deny: true, reason: `codex-reply는 등록된 스레드만(빌더/리뷰)(${threadId} 미등록) — 임의 스레드 차단` }
  return { deny: false }
}

// ── H2: Stop(미완료-확정 방지) ──────────────────────────────────────────
// complete=권위 재도출 결과. 미완료면 첫 호출 block. 재호출(stopHookActive)은 무조건 통과하지 않고
// footer 계약으로 판정: footer가 INCOMPLETE+blocker(정직 보고)면 통과, COMPLETE거나 footer 부재면 계속 block.
export function decideStop({ complete, blockers = [], footer = { present: false }, stopHookActive = false }) {
  if (complete) return { block: false }
  const summary = blockers.length ? blockers.slice(0, 8).join("; ") : "권위 재도출상 미완료"
  if (!stopHookActive)
    return { block: true, reason: `아직 완료 아님(권위 재도출): ${summary}. 남은 것을 끝내거나, 정직하게 미완료를 보고(HARNIE_STATUS: INCOMPLETE — <blocker>)하고 제어권을 반환하라.` }
  // 재호출: footer 계약
  if (footer.present && footer.status === "INCOMPLETE")
    return { block: false } // 정직한 미완료 보고 → 제어권 반환 허용
  return { block: true, reason: `권위상 미완료인데 COMPLETE 주장 또는 footer 부재. 정직 보고 footer가 필요: "HARNIE_STATUS: INCOMPLETE — ${summary}"` }
}
