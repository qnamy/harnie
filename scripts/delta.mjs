// harnie delta 헬퍼 — builder 실행 직전/직후 working tree를 git tree로 캡처해 증분 fix-delta 생성.
// 핵심: HEAD가 아니라 **직전 dirty 상태 대비**(기존 사용자 변경 오귀속 방지). `.harnie/` 제외.
// producer 자기보고에 의존하지 않고 orchestrator가 독립 생성.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"

// maxBuffer: 기본 1MB로는 대형 diff(대량 rebase 등)에서 ENOBUFS로 원인 불명 크래시(digest 제안 5).
function git(repo, args, env) {
  return execFileSync("git", ["-C", repo, ...args], {
    env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

export class CaptureObjectUnavailable extends Error {}

let captureBackend = null
let redirectNoticeWritten = false

export function captureBackendStatus() { return captureBackend }

function recordCaptureBackend(backend) {
  if (backend === "redirected") captureBackend = "redirected"
  else if (captureBackend == null) captureBackend = "default"
  if (backend === "redirected" && !redirectNoticeWritten) {
    process.stderr.write("harnie: Git object store redirected to .harnie/objects\n")
    redirectNoticeWritten = true
  }
}

export function captureObjectStore(repo) { return join(repo, ".harnie", "objects") }

function commonObjectStore(repo) {
  const raw = git(repo, ["rev-parse", "--git-common-dir"]).trim()
  return join(isAbsolute(raw) ? raw : resolve(repo, raw), "objects")
}

function alternateList(...paths) {
  return [...new Set(paths.flatMap((p) => String(p || "").split(delimiter)).filter(Boolean))].join(delimiter)
}

function unavailable(repo, sha, detail) {
  const store = captureObjectStore(repo)
  const original = commonObjectStore(repo)
  return new CaptureObjectUnavailable(
    `harnie capture object unavailable${sha ? ` (tree ${sha})` : ""}: ${detail}; ` +
    `harnie store=${store}, git store=${original}. 저장소를 복구한 뒤 다시 실행해야 합니다.`)
}

export function prepareCaptureObjectStore(repo) {
  const store = captureObjectStore(repo)
  if (!existsSync(store)) mkdirSync(store, { recursive: true })
  if (!statSync(store).isDirectory()) throw unavailable(repo, null, "harnie object store가 디렉터리가 아님")
  return store
}

// 있으면 alternate로 얹고, 없으면 그냥 얹지 않는다. 부재를 여기서 던지면 리다이렉트를 쓴 적 없는 run
// (0.14.6 이전 run 포함)이 전부 막힌다 — 판정은 아래 assertTreeReadable이 SHA 단위로 한다.
export function captureReadEnv(repo) {
  const store = captureObjectStore(repo)
  const usable = existsSync(store) && statSync(store).isDirectory()
  const alts = alternateList(usable ? store : "", process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES)
  return alts ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alts } : {}
}

export function assertTreeReadable(repo, sha) {
  const env = captureReadEnv(repo)
  try { git(repo, ["cat-file", "-e", `${sha}^{tree}`], env) }
  catch {
    const store = captureObjectStore(repo)
    const hint = existsSync(store) ? "" : " (harnie object store 자체가 없다 — 리다이렉트로 캡처한 tree라면 그 저장소가 지워진 것이다)"
    throw unavailable(repo, sha, `tree가 git store와 harnie store 어디에도 없음${hint}`)
  }
  return env
}

// 저장소 부재 자체는 치명이 아니다. 0.14.6 이전에 만들어진 run에는 이 저장소가 애초에 없고, 리다이렉트를
// 한 번도 쓰지 않은 run도 마찬가지다 — 그런 run에서 존재를 요구하면 runs·completion이 통째로 실패하면서
// "복구하라"고 안내하는데 복구할 대상이 없다. 지워진 저장소에 대한 보호는 읽기 쪽 assertTreeReadable이
// 맡는다: 그 SHA를 두 저장소 어디에서도 못 찾을 때만 fail-closed다.
function prepareCaptureStore(repo) {
  return prepareCaptureObjectStore(repo)
}

function newIndexEnv(extra = {}) {
  return { GIT_INDEX_FILE: join(mkdtempSync(join(tmpdir(), "harnie-idx-")), "index"), ...extra }
}

function captureWithDefaultObjects(repo) {
  const env = newIndexEnv()
  git(repo, ["add", "-A", "--", "."], env)
  git(repo, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".harnie"], env)
  return git(repo, ["write-tree"], env).trim()
}

function objectWritePermissionDenied(error) {
  const stderr = String(error && error.stderr || "")
  return /unable to create temporary file: (?:Operation not permitted|Permission denied)/i.test(stderr) ||
    /insufficient permission for adding an object to repository database/i.test(stderr)
}

function isWholeStateIgnored(repo) {
  try { git(repo, ["check-ignore", "-q", "--", ".harnie"]); return true }
  catch (e) { if (e && e.status === 1) return false; throw e }
}

function captureWithRedirectedObjects(repo, store) {
  const env = newIndexEnv({
    GIT_OBJECT_DIRECTORY: store,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateList(commonObjectStore(repo), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES),
  })
  const trackedState = git(repo, ["ls-files", "--", ".harnie"]).trim()
  const addArgs = isWholeStateIgnored(repo) && !trackedState
    ? ["add", "-A", "--", "."]
    : ["add", "-A", "--", ".", ":(exclude).harnie"]
  git(repo, addArgs, env)
  const indexedState = git(repo, ["ls-files", "--", ".harnie"], env).trim()
  if (indexedState) throw new Error(`captureTree: 임시 index에 .harnie 상태가 남음 — ${indexedState.split("\n")[0]}`)
  return git(repo, ["write-tree"], env).trim()
}

/**
 * 현재 working tree(추적 수정 + untracked 포함, `.harnie/` 제외)를 git tree object로 캡처.
 * 실제 index를 건드리지 않도록 임시 GIT_INDEX_FILE 사용.
 */
export function captureTree(repo) {
  const store = prepareCaptureStore(repo)
  try {
    const tree = captureWithDefaultObjects(repo)
    recordCaptureBackend("default")
    return tree
  }
  catch (e) {
    if (!objectWritePermissionDenied(e)) throw e
    const tree = captureWithRedirectedObjects(repo, store)
    recordCaptureBackend("redirected")
    return tree
  }
}

/**
 * baseline tree → 현재 tree 증분 delta. rename(-M)·binary 포함, `.harnie/` 제외.
 * expectScope(경로 배열)가 주어지면 그 밖의 변경을 outOfScope로 표시(외부/동시 변경 감지).
 */
export function computeDelta(repo, baselineSHA, { expectScope = null } = {}) {
  let readEnv = assertTreeReadable(repo, baselineSHA)
  const postSHA = captureTree(repo)
  readEnv = assertTreeReadable(repo, postSHA)
  const nameStatus = git(repo, ["diff", "--name-status", "-M", baselineSHA, postSHA], readEnv).trim()
  const patch = git(repo, ["diff", "-M", "--binary", baselineSHA, postSHA], readEnv)
  const changedPaths = nameStatus.split("\n").filter(Boolean).map((l) => {
    const parts = l.split("\t")
    return parts[parts.length - 1] // rename이면 마지막이 새 경로
  })
  let outOfScope = []
  if (expectScope) outOfScope = changedPaths.filter((p) => !expectScope.some((s) => p === s || p.startsWith(s.replace(/\/$/, "") + "/")))
  return { baselineSHA, postSHA, nameStatus, patch, changedPaths, outOfScope }
}
