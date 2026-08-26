// harnie delta 헬퍼 — builder 실행 직전/직후 working tree를 git tree로 캡처해 증분 fix-delta 생성.
// 핵심: HEAD가 아니라 **직전 dirty 상태 대비**(기존 사용자 변경 오귀속 방지). `.harnie/` 제외.
// producer 자기보고에 의존하지 않고 orchestrator가 독립 생성.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// maxBuffer: 기본 1MB로는 대형 diff(대량 rebase 등)에서 ENOBUFS로 원인 불명 크래시(digest 제안 5).
function git(repo, args, env) {
  return execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
}

/**
 * 현재 working tree(추적 수정 + untracked 포함, `.harnie/` 제외)를 git tree object로 캡처.
 * 실제 index를 건드리지 않도록 임시 GIT_INDEX_FILE 사용.
 */
export function captureTree(repo) {
  const idx = join(mkdtempSync(join(tmpdir(), "harnie-idx-")), "index")
  const env = { GIT_INDEX_FILE: idx }
  git(repo, ["add", "-A", "--", "."], env)
  git(repo, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".harnie"], env)
  return git(repo, ["write-tree"], env).trim()
}

/**
 * 워크스페이스 run(멀티레포)의 "전체 tree" 아티팩트 — 등록된 멤버 repo workroot들의 captureTree를
 * 키 정렬로 합성한 `ws:<sha256>` 문자열. 단일-repo의 40-hex tree SHA와 같은 자리(게이트 reviewedPostSHA
 * 바인딩)에 쓰이며, 어느 멤버 repo든 변경되면 값이 바뀐다. repos = {key: {workroot}}.
 */
export function captureWorkspaceTree(repos) {
  const entries = Object.entries(repos || {}).map(([key, v]) => [key, captureTree(v.workroot)])
  if (entries.length === 0) return null
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const canon = entries.map(([k, sha]) => `${k}=${sha}`).join("\n")
  return "ws:" + createHash("sha256").update(canon).digest("hex")
}

/**
 * baseline tree → 현재 tree 증분 delta. rename(-M)·binary 포함, `.harnie/` 제외.
 * expectScope(경로 배열)가 주어지면 그 밖의 변경을 outOfScope로 표시(외부/동시 변경 감지).
 */
export function computeDelta(repo, baselineSHA, { expectScope = null } = {}) {
  const postSHA = captureTree(repo)
  const nameStatus = git(repo, ["diff", "--name-status", "-M", baselineSHA, postSHA]).trim()
  const patch = git(repo, ["diff", "-M", "--binary", baselineSHA, postSHA])
  const changedPaths = nameStatus.split("\n").filter(Boolean).map((l) => {
    const parts = l.split("\t")
    return parts[parts.length - 1] // rename이면 마지막이 새 경로
  })
  let outOfScope = []
  if (expectScope) outOfScope = changedPaths.filter((p) => !expectScope.some((s) => p === s || p.startsWith(s.replace(/\/$/, "") + "/")))
  return { baselineSHA, postSHA, nameStatus, patch, changedPaths, outOfScope }
}
