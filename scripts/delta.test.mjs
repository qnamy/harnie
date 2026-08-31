import assert from "node:assert"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync, rmSync, renameSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureObjectUnavailable, captureObjectStore, captureTree, computeDelta } from "./delta.mjs"

const sh = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
let pass = 0, fail = 0
const t = (n, f) => { try { f(); pass++; console.log("✓ " + n) } catch (e) { fail++; console.log("✗ " + n + " — " + e.message) } }
const setDirsMode = (dir, mode) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) setDirsMode(path, mode)
  }
  chmodSync(dir, mode)
}
const redirectCapture = (root) => {
  const objects = join(root, ".git", "objects")
  setDirsMode(objects, 0o555)
  try { return captureTree(root) } finally { setDirsMode(objects, 0o755) }
}

// ── fixture repo ──
const repo = mkdtempSync(join(tmpdir(), "harnie-fx-"))
sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t")
writeFileSync(join(repo, "tracked.txt"), "orig\n")
writeFileSync(join(repo, "todelete.txt"), "del\n")
writeFileSync(join(repo, "old.txt"), "renameme\n")
writeFileSync(join(repo, "keep.txt"), "keep\n")
sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "init")

// 커밋 이후의 기존 사용자 dirty 변경(반드시 보존, builder 변경으로 오귀속 금지)
writeFileSync(join(repo, "keep.txt"), "keep\nUSER DIRTY\n")

// BASELINE = builder 실행 직전 dirty 상태 캡처
const baseline = captureTree(repo)

// builder 변경 (여러 종류)
writeFileSync(join(repo, "tracked.txt"), "orig\nBUILDER\n")             // tracked 수정
writeFileSync(join(repo, "untracked.txt"), "new\n")                     // untracked 추가
rmSync(join(repo, "todelete.txt"))                                      // 삭제
renameSync(join(repo, "old.txt"), join(repo, "new.txt"))               // rename
writeFileSync(join(repo, "new.txt"), "renameme\nMODIFIED\n")           // + 수정
writeFileSync(join(repo, "bin.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 10])) // binary
mkdirSync(join(repo, ".harnie"), { recursive: true })
writeFileSync(join(repo, ".harnie", "receipt.json"), '{"x":1}')          // receipt(제외 대상)

const scope = ["tracked.txt", "untracked.txt", "todelete.txt", "old.txt", "new.txt", "bin.bin"]
const d = computeDelta(repo, baseline, { expectScope: scope })

t("tracked 수정이 delta에", () => assert.ok(d.changedPaths.includes("tracked.txt")))
t("untracked 추가가 delta에", () => assert.ok(d.changedPaths.includes("untracked.txt")))
t("삭제가 delta에", () => assert.ok(/^D\ttodelete\.txt/m.test(d.nameStatus)))
t("rename이 delta에(old→new)", () => assert.ok(/^R\d*\told\.txt\tnew\.txt/m.test(d.nameStatus)))
t("binary가 delta에", () => assert.ok(d.changedPaths.includes("bin.bin")))
t("binary 패치에 GIT binary 표기", () => assert.ok(/GIT binary patch/.test(d.patch) || /Binary files/.test(d.patch)))
t(".harnie receipt는 delta에서 제외", () => assert.ok(!d.changedPaths.some((p) => p.startsWith(".harnie"))))
t("기존 dirty(keep.txt)는 delta에 없음 = baseline이 dirty 대비(HEAD 아님)", () => assert.ok(!d.changedPaths.includes("keep.txt")))
t("scope 안 변경이면 outOfScope 없음", () => assert.deepEqual(d.outOfScope, []))

// 외부/scope 밖 변경 감지
writeFileSync(join(repo, "sneaky.txt"), "out of scope\n")
const d2 = computeDelta(repo, baseline, { expectScope: ["tracked.txt"] })
t("scope 밖 변경 감지(외부/동시 변경)", () => assert.ok(d2.outOfScope.includes("sneaky.txt")))

// ── captureTree: .harnie가 gitignore에 등재된 상태에서도 예외 없이 성공 + 결과 tree에 .harnie 없음 ──
const repoC = mkdtempSync(join(tmpdir(), "harnie-fx-c-"))
sh(repoC, "init", "-q"); sh(repoC, "config", "user.email", "t@t"); sh(repoC, "config", "user.name", "t")
writeFileSync(join(repoC, ".gitignore"), ".harnie\n")
sh(repoC, "add", "-A"); sh(repoC, "commit", "-qm", "gitignore .harnie")
mkdirSync(join(repoC, ".harnie"), { recursive: true })
writeFileSync(join(repoC, ".harnie", "receipt.json"), '{"x":1}')
writeFileSync(join(repoC, "tracked-c.txt"), "c\n")
let capturedC = null, threwC = false
try { capturedC = captureTree(repoC) } catch { threwC = true }
t(".harnie가 gitignore된 상태에서도 captureTree가 예외 없이 성공(구 pathspec-exclude 버그 회귀 재현)", () => assert.equal(threwC, false))
t(".harnie가 gitignore된 상태에서도 캡처된 tree에 .harnie 항목 없음", () => {
  const lsTree = sh(repoC, "ls-tree", "-r", "--name-only", capturedC)
  assert.ok(!lsTree.split("\n").some((p) => p === ".harnie" || p.startsWith(".harnie/")))
})

// ── object DB redirect + cross-runtime read ──
const repoR = mkdtempSync(join(tmpdir(), "harnie-fx-redirect-"))
sh(repoR, "init", "-q"); sh(repoR, "config", "user.email", "t@t"); sh(repoR, "config", "user.name", "t")
writeFileSync(join(repoR, "source.txt"), "baseline\n")
sh(repoR, "add", "-A"); sh(repoR, "commit", "-qm", "init")
captureTree(repoR) // standalone capture가 harnie object store를 준비한다.
writeFileSync(join(repoR, "source.txt"), "redirected baseline\n")
const redirectedBaseline = redirectCapture(repoR)

t("기본 object DB 쓰기 권한이 없으면 harnie object store로 캡처한다", () => {
  assert.ok(statSync(captureObjectStore(repoR)).isDirectory())
  assert.throws(() => sh(repoR, "cat-file", "-e", `${redirectedBaseline}^{tree}`))
})

writeFileSync(join(repoR, "source.txt"), "interactive post\n")
const crossRuntime = computeDelta(repoR, redirectedBaseline)
t("정상 런타임의 computeDelta도 redirect baseline을 alternate로 읽는다", () => {
  assert.deepEqual(crossRuntime.changedPaths, ["source.txt"])
})

rmSync(captureObjectStore(repoR), { recursive: true, force: true })
t("harnie object store 유실은 SHA와 경로를 밝히며 fail-closed한다", () => {
  assert.throws(() => computeDelta(repoR, redirectedBaseline), (e) =>
    e instanceof CaptureObjectUnavailable && e.message.includes(redirectedBaseline) && e.message.includes(captureObjectStore(repoR)))
})

const redirectStateFixture = (name, ignore, tracked = false) => {
  const root = mkdtempSync(join(tmpdir(), `harnie-fx-${name}-`))
  sh(root, "init", "-q"); sh(root, "config", "user.email", "t@t"); sh(root, "config", "user.name", "t")
  if (ignore) writeFileSync(join(root, ".gitignore"), ignore)
  mkdirSync(join(root, ".harnie"), { recursive: true })
  if (tracked) writeFileSync(join(root, ".harnie", "tracked.txt"), "tracked control\n")
  writeFileSync(join(root, "source.txt"), "v1\n")
  sh(root, "add", "-f", "--", ".")
  sh(root, "commit", "-qm", "fixture")
  captureTree(root)
  writeFileSync(join(root, "source.txt"), "v2\n")
  const tree = redirectCapture(root)
  return { name, root, tree }
}

const redirectStateFixtures = [
  redirectStateFixture("whole-ignore", ".harnie/\n"),
  redirectStateFixture("partial-ignore", ".harnie/objects/\n"),
  redirectStateFixture("tracked-state", "", true),
]
for (const fixture of redirectStateFixtures) {
  t(`redirect 캡처가 상태 경로를 제외한다(${fixture.name})`, () => {
    const names = execFileSync("git", ["-C", fixture.root, "ls-tree", "-r", "--name-only", fixture.tree], {
      encoding: "utf8", env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: captureObjectStore(fixture.root) },
    })
    assert.ok(!names.split("\n").some((p) => p === ".harnie" || p.startsWith(".harnie/")))
  })
}

rmSync(repo, { recursive: true, force: true })
rmSync(repoC, { recursive: true, force: true })
rmSync(repoR, { recursive: true, force: true })
for (const fixture of redirectStateFixtures) rmSync(fixture.root, { recursive: true, force: true })
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
