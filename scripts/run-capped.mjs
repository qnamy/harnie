#!/usr/bin/env node
// 결정적 실행 상한 래퍼 — macOS에 `timeout` 명령이 없어 dev-solo의 리뷰 서브프로세스(claude -p / codex exec)에
// 무한 대기 방지를 걸 수 없는 문제의 대체(0.11 §6-h; codex-wrappers 행 락 사고 계보).
// 사용: node run-capped.mjs <timeout-ms> <cmd> [args…]
// 종료 코드: 자식 종료 코드 전달, 상한 초과 kill = 124, spawn 실패 = 127.
import { spawnSync } from "node:child_process"

const [, , timeoutArg, cmd, ...args] = process.argv
const timeout = Number(timeoutArg)
if (!Number.isInteger(timeout) || timeout <= 0 || !cmd) {
  process.stderr.write("run-capped: 사용법 node run-capped.mjs <timeout-ms> <cmd> [args…]\n")
  process.exit(2)
}
const r = spawnSync(cmd, args, { stdio: "inherit", timeout })
// spawnSync의 timeout은 error=ETIMEDOUT과 signal을 함께 반환한다 — timeout 식별이 generic spawn 실패(127)보다 먼저.
if (r.signal || (r.error && r.error.code === "ETIMEDOUT")) {
  process.stderr.write(`run-capped: 상한 ${timeout}ms 초과 또는 시그널(${r.signal || "ETIMEDOUT"})로 종료 — 결과 무효\n`)
  process.exit(124)
}
if (r.error) {
  process.stderr.write(`run-capped: spawn 실패 — ${r.error.message}\n`)
  process.exit(127)
}
process.exit(typeof r.status === "number" ? r.status : 1)
