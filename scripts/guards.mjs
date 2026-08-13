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
  if (p.startsWith(".harnie/pending-route/")) return true // per-session route 파일 보호(다른 세션의 raw 변경/삭제 차단, P1-3)
  if (p === ".harnie/state.lock") return true             // state lock 보호
  return CONTROL_BASENAMES.has(p.split("/").pop())
}

const PLANNING_PHASES = new Set(["planning", "awaiting-approval"])

// ── H1: Write|Edit ──────────────────────────────────────────────────────
// 1) control·review-state 직접 쓰기는 phase 무관 deny. 2) 승인 前(planning/awaiting)엔 `.harnie/<track>/<slug>/` 밖 전부 deny.
// outside=true(호출자가 판단한 repo 밖 경로)면 2)는 적용하지 않는다 — run 디렉터리 기준 상대경로 규칙이 repo 밖 경로에
// 의미가 없기 때문(예: scratchpad 메모). control 검사는 그대로 유지한다. 기본 false라 호출자 미변경 시 동작 불변.
export function decideWriteEdit({ relPath, phase, track, slug, outside = false }) {
  const p = String(relPath).replace(/\\/g, "/")
  if (isControlPath(p))
    return { deny: true, reason: `control·review-state 직접 쓰기 금지(${p}) — 기록은 execution.mjs·loop.mjs로만` }
  if (!outside && PLANNING_PHASES.has(phase)) {
    const allowed = `.harnie/${track}/${slug}/`
    if (!p.startsWith(allowed))
      return { deny: true, reason: `승인 前(${phase}) 소스 쓰기 금지 — ${allowed} 밖(${p})은 승인 게이트 후에만` }
  }
  return { deny: false }
}

// ── H1: Bash ────────────────────────────────────────────────────────────
// sanctioned CLI(node …/loop.mjs·execution.mjs, 셸 연산자·리다이렉트 없음)만 예외 — 단, 그 CLI 자체가
// output/ledger/state 경로를 `.harnie/` 안으로 검증하므로 임의 경로 쓰기 primitive가 되지 않는다.
// 항상: .harnie는 좁은 positive 읽기 판정(isHarnieRead)만 통과, 그 밖은 deny. **승인 前(planning/awaiting):
// read-only 명령·sanctioned CLI만 allow**(§5.1 allowlist, git apply·npm·인터프리터·리다이렉트 등 쓰기·부작용 fail-closed).
// 셸 메타 — 연쇄·서브셸·리다이렉트·**프로세스 치환·개행**까지. read-only 판정은 lexSegments가 인용을 인식해 처리한다.
const SHELL_ANY = /[;|&`\n\r]|\$\(|<\(|>\(|[<>]/ // sanctioned CLI는 파이프 포함 어떤 메타도 불가
const HARNIE_REF = /\.harnie\b/i                 // 비-sanctioned Bash의 .harnie 접근 차단(case-insensitive FS의 .HARNIE 포함)
// 셸 quote/백슬래시로 `.har""nie`처럼 쪼개 literal 매칭을 우회하는 것을 막기 위해 **quote·백슬래시 제거 후** 매칭(P1-2).
// (echo ".harnie" 같은 텍스트도 걸리지만 .harnie 참조를 막는 쪽이 안전 — fail-safe.)
function stripQuoting(cmd) { return String(cmd || "").replace(/['"\\]/g, "") }
export function referencesHarnie(cmd) { return HARNIE_REF.test(stripQuoting(cmd)) } // baseline .harnie Bash 보호용(active 무관, P1-3)
// 승인 前 허용하는 read-only 명령. 쓰기 능력이 없는 명령만 담고, 쓰기 옵션 토큰(WRITE_FLAG)은 별도로 거부한다
// (find는 재포함 — `-delete`·`-exec` 등 쓰기 옵션만 막으면 조사용 `find . -name …`은 안전. sort/yq는 `-o`/`-i`가
//  기본 사용형이라 계속 제외. tree·uniq는 각각 `-o <파일>`·`uniq <in> <out>`으로 **파일을 쓰는 형태**가 있어 제외.)
const RO_CMDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "echo", "which", "type",
  "file", "stat", "dirname", "basename", "realpath", "readlink", "cut", "comm",
  "column", "jq", "diff", "cmp", "date", "printenv", "hostname", "whoami", "uname", "du", "df", "test", "nl", "fold",
  "find",
])
const GIT_RO = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree", "rev-parse", "cat-file", "blame", "describe",
  "shortlog", "merge-base", "name-rev", "symbolic-ref", "for-each-ref", "show-ref", "rev-list",
])
// git 전역 옵션(하위명령 **앞**에 오는 것) — 값이 따로 오는 형태와 `=` 형태 모두 스킵해야 하위명령을 찾을 수 있다.
// (`git -C /path rev-parse HEAD`가 toks[1]="-C"라서 read-only 판정에 실패하던 오탐 수정.)
// 주: `-c core.pager=…`류로 간접 실행을 얹는 경로는 **이 승인-前 소스 게이트에 남은 DR-002 부채**다(열거로 닫히지 않음).
// 권위 상태(`.harnie`)는 이 판정을 쓰지 않고 isHarnieRead(positive allowlist, git 제외)가 막는다.
const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])
const GIT_GLOBAL_FLAG = /^(-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks)$/
function gitSubcommand(toks) {
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]
    if (GIT_GLOBAL_VALUE.has(t)) { i++; continue }                                   // `-C <dir>`·`-c <k=v>` — 값 토큰까지 스킵
    if (t.includes("=") && GIT_GLOBAL_VALUE.has(t.slice(0, t.indexOf("=")))) continue // `--git-dir=…` 형태
    if (GIT_GLOBAL_FLAG.test(t)) continue
    return t
  }
  return undefined
}
const WRITE_FLAG = /^(--output(=.*)?|--out(=.*)?|-delete|--delete|-exec|-execdir|-ok|-okdir|--in-place|--inplace|-fprint.*|-fls)$/
// 외부 프로그램을 실행시키는 옵션 — 명령 자체는 read-only여도 임의 실행 통로가 되므로 거부(DR-002 일부).
const EXEC_FLAG = /^(--pre(=.*)?|--pre-glob(=.*)?|--hostname-bin(=.*)?|--ext-diff)$/
// stderr 억제만 리다이렉트 예외로 허용(`2>/dev/null`·`2>&1`) — 파일 쓰기 능력이 없다. 렉서가 `>`·`&`를 거부하므로 선처리한다.
const STDERR_REDIRECT = /\s2>\s*(?:&1|\/dev\/null)(?=\s|$)/g
// 셸 인용·이스케이프를 인식해 **파이프 세그먼트별 argv**로 분해한다(판정 전용 — 실행 명령은 변형하지 않는다).
// 인용 밖 셸 메타(연쇄·서브셸·리다이렉트·프로세스치환·개행)와 **큰따옴표 안에서도 살아있는 치환**(`$(`·백틱)을
// 만나면 null = 판정 불가 → 호출자가 fail-closed. 인용 안의 `|`·`;`는 리터럴이라 세그먼트를 쪼개지 않는다.
// 토큰은 인용·이스케이프를 벗겨 실제 argv와 같게 만든다 — `'-delete'`·`\-delete`가 플래그 검사를 빠져나가지 못하게.
//
// brace·glob 확장도 같은 계약을 깬다(`{--pre,/bin/rm}`은 두 단어로, 무접두 `*`는 `-`로 시작하는 파일명으로 확장될 수 있고
// 실제로 `rg --pre /bin/rm`이 되어 파일이 삭제되는 것이 실증됐다). 확장 결과는 **항상 토큰의 리터럴 접두어로 시작**하므로,
// 접두어가 비어 있지 않고 `-`로 시작하지 않으면 옵션 형태로 확장될 수 없다 — 그 경우만 통과시키고(`.harnie/*`·`src/*`)
// 나머지(`*`·`{a,b}`·`?x`·`-*`)는 fail-closed. 인용된 `'*.mjs'`는 셸이 확장하지 않으므로 대상이 아니다.
const EXPAND_META = "*?[]{}"
function lexSegments(cmd) {
  const s = String(cmd || "")
  const segments = []
  let toks = [], cur = "", started = false, expanded = false, prefixSafe = false, unsafeExpand = false
  const endTok = () => {
    if (!started) return
    if (expanded && !prefixSafe) unsafeExpand = true // 확장이 옵션 형태를 만들 수 있는 토큰
    toks.push(cur); cur = ""; started = false; expanded = false; prefixSafe = false
  }
  const endSeg = () => { endTok(); segments.push(toks); toks = [] }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "\\") { const n = s[i + 1]; if (n === undefined || n === "\n" || n === "\r") return null; cur += n; started = true; i++; continue }
    if (ch === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return null; cur += s.slice(i + 1, j); started = true; i = j; continue }
    if (ch === "\"") {
      let j = i + 1
      for (; j < s.length && s[j] !== "\""; j++) {
        const c = s[j]
        if (c === "\\") { if (s[j + 1] === undefined) return null; cur += s[j + 1]; j++; continue }
        if (c === "`" || c === "$") return null // 큰따옴표 안에서도 치환·확장은 살아있다
        cur += c
      }
      if (j >= s.length) return null // 닫히지 않은 인용
      started = true; i = j; continue
    }
    if (ch === "|") { endSeg(); continue }
    if (ch === " " || ch === "\t") { endTok(); continue }
    // `$`는 홑따옴표 밖에서 **전부** 거부: `$(`뿐 아니라 `$VAR`·`${X:--delete}`도 셸이 임의 값으로 확장하므로
    // 여기서 본 토큰이 실제 argv라는 보장이 깨진다(확장 결과가 `-delete`가 되는 실증 사례가 있었다).
    if (ch === "$") return null
    if (";&`<>()\n\r".includes(ch)) return null
    if (EXPAND_META.includes(ch) && !expanded) { expanded = true; prefixSafe = cur.length > 0 && cur[0] !== "-" }
    cur += ch; started = true
  }
  endSeg()
  return unsafeExpand ? null : segments
}
// ── `.harnie` 권위 상태 읽기 판정(좁은 positive allowlist) ───────────────
// isReadOnlyBash는 **부작용 옵션 denylist**라 원리적으로 완전하지 않다(`tree -o`·`find -okdir`·`git -c core.pager=…`,
// 심지어 플래그 없는 `uniq <in> <out>`처럼 위치인자로 쓰는 형태까지 있어 열거로 닫히지 않는다 = DR-002).
// 그래서 권위 상태(`.harnie`) 읽기는 그 판정을 재사용하지 않고, **아는 읽기 명령 + 아는 무해 플래그만** 통과시키고
// **모르는 플래그·명령은 전부 거부**한다(모름 → deny). find·git·tree·uniq처럼 쓰기 형태가 있는 명령은 아예 제외.
// `file`은 `-C -m`으로 magic 파일을 **컴파일해 쓰는** 형태가 있어 제외했다. 상태 조회에 필요치 않은 명령은 넣지 않는다.
const HARNIE_READ_CMDS = new Set([
  "cat", "ls", "head", "tail", "wc", "jq", "grep", "egrep", "fgrep", "rg", "stat", "test",
  "nl", "realpath", "readlink", "basename", "dirname", "cmp", "du", "column",
])
// 무해 플래그: 짧은 플래그(문자/숫자 1~2개, 예 `-n`·`-5`·`-nE`)와 명시 열거한 긴 플래그만.
// 긴 플래그를 통째로 허용하지 않는 게 핵심 — `--pre`·`--output=` 같은 부작용 옵션이 모두 여기서 걸린다.
// 열린 후속(non-blocking): 짧은 플래그 중에도 외부 프로그램을 부르는 것이 있다(`rg -z`가 압축 해제기 호출).
// 정상 바이너리 기준 읽기 동작이고 쓰기 능력이 없어 §0.1 blocker는 아니지만, 이 판정을 **명령별 플래그 집합**으로
// 더 좁힐 때 함께 정리한다(그때 `-z`·조합형 `-nz`까지 문자 단위로 검사해야 한다).
const HARNIE_READ_FLAG = /^-(?:[A-Za-z0-9]{1,2}|-(?:color|json|line-number|no-heading|text|null-data)(?:=[\w.,-]+)?)$/
export function isHarnieRead(cmd) {
  const segments = lexSegments(String(cmd || "").replace(STDERR_REDIRECT, " "))
  if (segments == null) return false // 셸 메타·치환·확장·닫히지 않은 인용 → 판정 불가
  if (!segments.length) return false
  for (const toks of segments) {
    if (!toks.length) return false
    // 경로지정 실행파일(`/tmp/cat`·`./cat`)은 이름만 보면 위장이 통하므로 **bare 이름만** 허용(DR-004와 같은 취지).
    if (toks[0].includes("/") || !HARNIE_READ_CMDS.has(toks[0])) return false
    for (const t of toks.slice(1)) if (t.startsWith("-") && !HARNIE_READ_FLAG.test(t)) return false
  }
  return true
}

// 파이프 각 세그먼트의 선두가 read-only(또는 안전한 git 하위명령)이고 쓰기·실행 옵션이 없는지.
// **주의**: 이 판정은 승인-前 소스 쓰기 게이트용이며 denylist라 완전하지 않다(DR-002). 권위 상태 보호에는 쓰지 말 것.
function isReadOnlyBash(cmd) {
  const segments = lexSegments(String(cmd || "").replace(STDERR_REDIRECT, " "))
  if (segments == null) return false // 판정 불가(셸 메타·치환·닫히지 않은 인용) → fail-closed
  for (const toks of segments) {
    if (!toks.length) return false // 빈 세그먼트(`| foo`·빈 명령) → 판정 불가
    const base = toks[0].split("/").pop()
    if (base === "git") { if (!GIT_RO.has(gitSubcommand(toks))) return false }
    else if (!RO_CMDS.has(base)) return false
    if (toks.some((t) => WRITE_FLAG.test(t) || EXEC_FLAG.test(t))) return false
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
  // 비-sanctioned Bash의 .harnie 접근은 phase 무관, **좁은 positive 읽기 판정**(isHarnieRead)만 통과.
  // 일반 isReadOnlyBash(denylist)를 쓰면 `tree -o`·`find -okdir`·`uniq <in> <out>` 같은 형태가 새 나가므로 쓰지 않는다.
  // (전면 차단은 `cat .harnie/active.json`조차 막던 오탐이라, 차단을 유지하되 판정을 좁게 만든 것.)
  if (referencesHarnie(cmd) && !isHarnieRead(cmd))
    return { deny: true, reason: `Bash로 .harnie 접근은 좁은 읽기 형태만(아는 읽기 명령+짧은 플래그) — 상태 기록·변경은 loop.mjs·execution.mjs(신뢰 CLI)로만` }
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
// 설치본에선 서브에이전트 타입이 plugin-namespaced로 온다(예: `harnie:harnie-scout`) → `harnie:` 접두어 정규화 후 대조.
// (미정규화 시 read-only scout/designer가 승인 前 조사에서 오차단돼 Explore 폴백 — 라이브 검증서 노출된 버그.)
function normalizeAgentType(t) {
  return typeof t === "string" && t.startsWith("harnie:") ? t.slice("harnie:".length) : t
}
export function decideTask({ subagentType, phase }) {
  if (PLANNING_PHASES.has(phase) && !READONLY_AGENTS.has(normalizeAgentType(subagentType)))
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
