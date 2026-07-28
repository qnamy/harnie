// harnie ledger 헬퍼 — instructions/loop.md 계약의 결정적·엄격·트랜잭션 구현.
// false approval 방지: 블록 기반 엄격 파싱 + 필수 namespace + persisted ledger 검증(fail-closed) + 무효 시 롤백.

const STRICT_ISSUE_RE =
  /^\s*-\s*\[([^\]]+)\]\s+\((blocking|non-blocking)\)\s+\((open|resolved)\)\s+\[([^\]]+)\]\s+(\S.*?)\s*$/
const ID_RE = /^[A-Z]{2}-\d+$/

function requireNamespace(ns, who) {
  if (ns !== "CR" && ns !== "DR") throw new Error(`${who}: namespace는 "CR" 또는 "DR" 필수 (got ${JSON.stringify(ns)})`)
}

/**
 * 리뷰 응답 텍스트 → { ok, errors[], verdict, issues[] }.
 * 엄격: VERDICT·ISSUES 각 정확히 1회. ISSUES 블록의 **모든 비어있지 않은 행**은
 * 스키마 일치(또는 code fence)여야 하며, 아니면 parse error. namespace 필수(CR|DR).
 */
export function parseReview(text, { namespace } = {}) {
  requireNamespace(namespace, "parseReview")
  const errors = []
  let lines = text.split("\n")

  // 앞뒤 공백 행 제거
  while (lines.length && lines[0].trim() === "") lines.shift()
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()

  // 선택적 outer fence(전체 계약을 한 번 감쌈)만 지원 — 벗겨낸다.
  if (lines.length && /^```/.test(lines[0].trim())) {
    if (lines.length >= 2 && /^```$/.test(lines[lines.length - 1].trim())) lines = lines.slice(1, -1)
    else errors.push(`outer fence가 닫히지 않음`)
  }
  // 내부 fence 금지(계약 전체를 감싸는 outer fence 외엔 허용 안 함)
  for (const l of lines) if (/^```/.test(l.trim())) errors.push(`계약 내부 fence 금지: ${l.trim()}`)

  // exact grammar — 비공백 행은 VERDICT 1 · ISSUES 1 · 이슈 행만.
  const nb = lines.filter((l) => l.trim() !== "")
  const verdictIdxs = nb.map((l, i) => (/^VERDICT:/i.test(l.trim()) ? i : -1)).filter((i) => i >= 0)
  if (verdictIdxs.length !== 1) errors.push(`VERDICT는 정확히 1회(발견 ${verdictIdxs.length})`)
  let verdict = null
  if (verdictIdxs.length === 1) {
    verdict = (nb[verdictIdxs[0]].match(/^\s*VERDICT:\s*(.*)$/i)?.[1] || "").trim().toUpperCase()
    if (verdict !== "APPROVE" && verdict !== "REJECT") errors.push(`VERDICT는 APPROVE|REJECT`)
  }

  const issuesIdxs = nb.map((l, i) => (/^ISSUES:/i.test(l.trim()) ? i : -1)).filter((i) => i >= 0)
  if (issuesIdxs.length !== 1) {
    errors.push(`ISSUES는 정확히 1회(발견 ${issuesIdxs.length})`)
    return { ok: false, errors, verdict, issues: [] }
  }
  const iIdx = issuesIdxs[0]
  const inline = (nb[iIdx].match(/^\s*ISSUES:\s*(.*)$/i)?.[1] || "").trim()
  const emptyMarker = /^\[\s*\]$/.test(inline)
  if (inline && !emptyMarker) errors.push(`ISSUES: 뒤에는 [] 또는 아무것도 없어야 함`)

  // ISSUES 이전: VERDICT 외 행 금지(prose·bullet·추가 header 불가)
  for (let i = 0; i < iIdx; i++) if (!/^VERDICT:/i.test(nb[i].trim())) errors.push(`ISSUES 이전 계약 외 행: ${nb[i].trim()}`)

  // ISSUES 이후: 이슈 행만
  const issues = []
  const seen = new Set()
  for (let i = iIdx + 1; i < nb.length; i++) {
    const m = nb[i].match(STRICT_ISSUE_RE)
    if (!m) { errors.push(`계약 외 행: ${nb[i].trim()}`); continue }
    const [, id, bl, st, loc, body] = m
    if (!ID_RE.test(id)) errors.push(`ID 형식 오류: ${id}`)
    if (!id.startsWith(namespace + "-")) errors.push(`ID ${id} namespace ${namespace} 아님`)
    if (seen.has(id)) errors.push(`중복 ID ${id}`)
    seen.add(id)
    issues.push({ id, blocking: bl === "blocking", status: st, location: loc.trim(), text: body.trim() })
  }
  if (emptyMarker && issues.length > 0) errors.push(`ISSUES: [] 인데 이슈 행 존재`)
  if (!emptyMarker && issues.length === 0) errors.push(`이슈가 없으면 ISSUES: [] 필수`)

  return { ok: errors.length === 0, errors, verdict, issues }
}

/** persisted ledger 무결성 검증 — 손상 시 fail-closed. */
export function validateLedger(ledger, { namespace }) {
  requireNamespace(namespace, "validateLedger")
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger))
    return ["ledger 최상위가 plain object 아님"]
  const errors = []
  for (const [key, e] of Object.entries(ledger)) {
    if (!e || typeof e !== "object") { errors.push(`${key}: 엔트리가 객체 아님`); continue }
    if (e.id !== key) errors.push(`${key}: id 필드 불일치(${JSON.stringify(e.id)})`)
    if (!ID_RE.test(key)) errors.push(`${key}: ID 형식 오류`)
    if (!key.startsWith(namespace + "-")) errors.push(`${key}: namespace ${namespace} 아님`)
    if (typeof e.blocking !== "boolean") errors.push(`${key}: blocking이 boolean 아님`)
    if (e.status !== "open" && e.status !== "resolved") errors.push(`${key}: status가 open|resolved 아님(${JSON.stringify(e.status)})`)
    if (typeof e.location !== "string" || !e.location.trim()) errors.push(`${key}: location 누락(공백만도 불가)`)
    if (typeof e.text !== "string" || !e.text.trim()) errors.push(`${key}: text 누락(공백만도 불가)`)
  }
  return errors
}

export function openIds(ledger) {
  return Object.keys(ledger).filter((id) => ledger[id].status === "open")
}
export function openBlockingCount(ledger) {
  return Object.values(ledger).filter((i) => i.status === "open" && i.blocking).length
}
export function verdictConsistent(verdict, ledger) {
  const ob = openBlockingCount(ledger)
  if (verdict === "APPROVE") return ob === 0
  if (verdict === "REJECT") return ob >= 1
  return false
}

/**
 * parsed 리뷰를 이전 ledger에 트랜잭션 병합. 재리뷰 대상 = prevLedger의 모든 open(내부 계산).
 * fail-closed: 손상 ledger·파싱 오류·시맨틱 오류·verdict 불일치·blocking 누락 → 롤백(불변, gateProgress=null).
 */
export function mergeLedger(prevLedger, parsed, { namespace } = {}) {
  requireNamespace(namespace, "mergeLedger")
  const ledgerErrors = validateLedger(prevLedger, { namespace })
  if (ledgerErrors.length)
    return { committed: false, ledger: prevLedger, reasons: ledgerErrors.map((e) => `손상된 ledger: ${e}`), needsReRequest: true, gateProgress: null, protocolViolations: [], omittedBlocking: [], verdictValid: false, prevOpenBlocking: null, newOpenBlocking: null }

  const prevOpenBlocking = openBlockingCount(prevLedger)
  const rollback = (reasons, extra = {}) => ({ committed: false, ledger: prevLedger, reasons, needsReRequest: true, gateProgress: null, protocolViolations: [], omittedBlocking: [], verdictValid: false, prevOpenBlocking, newOpenBlocking: prevOpenBlocking, ...extra })
  if (!parsed.ok) return rollback(parsed.errors)

  const reasons = []
  for (const iss of parsed.issues) {
    const prev = prevLedger[iss.id]
    if (prev && prev.blocking !== iss.blocking) reasons.push(`${iss.id} blocking 분류 변경 금지(같은 ID resolved로 닫고 새 ID 사용)`)
    if (!prev && iss.status === "resolved") reasons.push(`미지 ID ${iss.id}를 처음부터 resolved로 제출`)
  }

  const candidate = {}
  for (const [id, i] of Object.entries(prevLedger)) candidate[id] = { ...i }
  for (const iss of parsed.issues) candidate[iss.id] = { id: iss.id, blocking: iss.blocking, status: iss.status, location: iss.location, text: iss.text }

  const targets = openIds(prevLedger)
  const reported = new Set(parsed.issues.map((i) => i.id))
  const protocolViolations = []
  for (const id of targets) if (!reported.has(id)) { protocolViolations.push(id); candidate[id].status = "open" }
  const omittedBlocking = protocolViolations.filter((id) => prevLedger[id].blocking)

  const verdictValid = verdictConsistent(parsed.verdict, candidate)
  if (!verdictValid) reasons.push(`verdict ${parsed.verdict}가 open blocking 수와 불일치`)

  if (reasons.length > 0 || omittedBlocking.length > 0) return rollback(reasons, { protocolViolations, omittedBlocking, verdictValid })

  const newOpenBlocking = openBlockingCount(candidate)
  return { committed: true, ledger: candidate, reasons: [], needsReRequest: false, protocolViolations, omittedBlocking: [], verdictValid: true, prevOpenBlocking, newOpenBlocking, gateProgress: newOpenBlocking < prevOpenBlocking }
}
