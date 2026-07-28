import assert from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, renameSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureTree, computeDelta } from "./delta.mjs"

const sh = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
let pass = 0, fail = 0
const t = (n, f) => { try { f(); pass++; console.log("✓ " + n) } catch (e) { fail++; console.log("✗ " + n + " — " + e.message) } }

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

rmSync(repo, { recursive: true, force: true })
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
