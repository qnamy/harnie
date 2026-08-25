// run-capped.mjs — 결정적 실행 상한 래퍼(0.11 §6-h) 계약: 상한 초과=124, spawn 실패=127, 그 외 자식 종료코드 전달.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = join(dirname(fileURLToPath(import.meta.url)), "run-capped.mjs")
const run = (...args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" })

test("run-capped: 자식 종료코드 전달(성공 0·실패 코드 그대로)", () => {
  assert.equal(run("30000", "node", "-e", "process.exit(0)").status, 0)
  assert.equal(run("30000", "node", "-e", "process.exit(7)").status, 7)
})

test("run-capped: 상한 초과는 124(ETIMEDOUT/signal이 generic 127보다 먼저 식별)", () => {
  const r = run("300", "node", "-e", "setTimeout(() => {}, 60000)")
  assert.equal(r.status, 124)
  assert.match(r.stderr, /상한 300ms 초과/)
})

test("run-capped: spawn 실패(미존재 명령)는 127, 잘못된 사용법은 2", () => {
  assert.equal(run("30000", "definitely-not-a-command-xyz").status, 127)
  assert.equal(run("0", "node", "-e", "0").status, 2)       // timeout 양의 정수 필요
  assert.equal(run("abc", "node", "-e", "0").status, 2)
  assert.equal(spawnSync("node", [CLI, "1000"], { encoding: "utf8" }).status, 2) // cmd 누락
})
