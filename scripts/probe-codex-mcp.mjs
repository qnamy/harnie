// 실행 가능한 probe — codex mcp-server가 노출하는 tool 이름·inputSchema를 덤프한다.
// 모델 호출 없음(initialize + tools/list 뿐). 사용: node scripts/probe-codex-mcp.mjs
// 실패 시 spawn error·stderr·조기 exit를 명시 출력(원인이 TIMEOUT으로 가려지지 않게).
import { spawn } from "node:child_process"

const child = spawn("codex", ["mcp-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env })
let buf = "", err = ""
const timer = setTimeout(() => {
  console.error("TIMEOUT: tools/list 응답 없음(20s).")
  if (err.trim()) console.error("stderr:", err.slice(0, 1000))
  try { child.kill("SIGKILL") } catch {}
  process.exit(1)
}, 20000)
const done = (code) => { clearTimeout(timer); try { child.kill("SIGKILL") } catch {}; process.exit(code) }
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n")

child.on("error", (e) => { clearTimeout(timer); console.error("spawn error:", e.message); process.exit(1) })
child.stderr.on("data", (d) => { err += d.toString() })
child.on("exit", (code, signal) => {
  if (code !== 0 && code !== null) {
    clearTimeout(timer)
    console.error(`codex mcp-server 조기 종료 (code=${code} signal=${signal})`)
    if (err.trim()) console.error("stderr:", err.slice(0, 1000))
    process.exit(1)
  }
})
child.stdout.on("data", (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id === 1 && m.result) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }
    if (m.id === 2) {
      for (const tool of m.result?.tools ?? []) {
        console.log("\n===== " + tool.name + " =====")
        console.log("params:", Object.keys(tool.inputSchema?.properties ?? {}).join(", "))
        console.log("required:", (tool.inputSchema?.required ?? []).join(", "))
        const sb = tool.inputSchema?.properties?.sandbox
        if (sb?.enum) console.log("sandbox enum:", sb.enum.join(" | "))
      }
      done(0)
    }
  }
})
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "harnie-probe", version: "0.0.1" } } })
