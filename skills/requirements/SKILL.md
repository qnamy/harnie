---
name: requirements
description: Turn a short or vague development request into a requirements document that admits only one reading, by scanning it for ambiguity, resolving the ambiguities that would change the resulting software, and recording the rest as explicit assumptions. Use before design or implementation starts, whenever scope, failure behavior, or completion criteria are still open — including requests that look small. Produces a Korean requirements file at the path the user names.
---

# Requirements Analysis (Ambiguity First)

**The deliverable is a request whose every reading that would produce different software is either settled or marked** — none left silent. Not a long document, not a template filled in. Length that removes no reading is cost with no return.

The failure to work against is proceeding silently on an ambiguous request. It is the default behavior, and it is expensive.

## Procedure

1. Restate the request in one sentence. If you cannot, you do not yet know what is being asked.
2. Scan for ambiguity (§1) and show the user the marks.
3. Ask about what the scan found (§2).
4. Record the defaults you chose in place of asking (§3).
5. Write the document (§4).
6. Self-check (§5), confirm with the user, hand off the file path.

## 1. Ambiguity scan

Mark each axis **명확 / 부분 / 누락**.

| Axis | The question it answers |
|---|---|
| 범위 경계 | What is in, and what is explicitly out |
| 트리거·행위자 | Who or what starts this, and when |
| 데이터·상태 소유 | Which store is already the system of record, what persists, what is derived. Choosing a new store is design, not this |
| 실패·예외 동작 | What happens on error, timeout, duplicate, and concurrent execution |
| 외부 연동 | Which systems are touched, under whose contract |
| 품질·제약 | The numbers that change the design: volume, latency, retention, limits |
| 완료 판정 | How anyone observes that this is done |
| 용어 | Terms carrying more than one meaning in this codebase or team |

## 2. Asking

Ask when the readings lead to **different software**. Otherwise assume and log.

Prefer the form that costs the reader least:

1. **Propose a concrete behavior, ask yes/no** — "중복 요청이 오면 두 번째를 무시하고 첫 결과를 반환합니다. 맞습니까." Confirming a stated behavior is cheaper than composing an answer, and the answer is a sentence you can put straight into the document.
2. **Two to five mutually exclusive options**, one marked as your recommendation.
3. **An open question** — only for product intent the first two cannot carry.

Each question states what changes depending on the answer.

## 3. Assumptions and open items

- **`[가정]`** — the default you chose, and what would make it wrong. Without these the reader cannot tell which sentences are the requester's and which are yours.
- **`[미결정]`** — unresolved, with the reason, who can settle it, and what it blocks. Never delete one to make the document look finished, and never fill one in yourself. A reading you could not settle is handled by marking it, not by removing it: an open `[미결정]` does not stop the document from being handed over, as long as the handoff says which decisions are waiting on it.

Log resolved questions as `Q: … → A: …` at the end, and **replace** the text an answer invalidated rather than adding beside it.

## 4. Output document

Korean, at the path the user names (default `requirements.md`). A few lines per section for small work; never pad a section to fill it. The eight axes do not map one-to-one onto these sections — what a scan resolved goes into the requirement sentence describing that behavior.

1. **목표와 문제** — what is being solved and why now.
2. **범위 · 비범위** — including at least one line of what will not be built. 비범위 is a decision to exclude; anything still undecided belongs in 5 instead.
3. **기능 요구** — observable behavior, one statement each. Whether a behavior exists belongs here; how much, how fast, or within what limit belongs in 4. Add a `Given / When / Then` scenario only where judgment could split on whether the behavior is met.
4. **품질·제약 요구** — only constraints that change a design decision, each stated so it can be checked true or false: as a number where it has one, and as an explicit condition where it does not, such as a data-residency rule or a compatibility target.
5. **가정 · 미결정** — mark an assumption that attaches to a single value at that value, and collect here only the premises the whole document rests on, plus every `[미결정]`.
6. **완료 판정** — only end conditions that do not reduce to the individual requirements being met, such as a migration being finished or existing behavior staying intact. If everything here restates 3, leave the section out.

Identifiers (`FR-001`) only where something else references them. No traceability matrix, no fixed requirement-syntax template.

## 5. Self-check

One pass over the finished draft, before showing it. Read each requirement sentence on its own and look for these four:

- **주관적 표현** — 사용하기 쉬운, 직관적인, 안정적인
- **모호한 부사·형용사** — 대부분, 충분히, 최소한의, 적절한
- **빠져나갈 구멍** — 가능한 한, 필요시, 적절히 처리한다
- **검증 불가한 개방형 표현** — 등, 기타, 유사한 경우

A sentence that trips one of these gets rewritten as an observable outcome. **If it cannot be rewritten, it was never a requirement — move it to `[미결정]` with what is missing.** Do not extend this list; wider wording rules produce about one false alarm per real one.

Then, over the whole document: can each requirement be observed as met or not met, and does each trace to a stated need or a failure it prevents? Cut what fails the second question.

## Do not

- Do not invent facts about the codebase or the product. An unverifiable premise is `[미결정]`.
- Do not treat requirement count, section count, or document length as quality.
- Do not design. Alternatives, structure, and technology choices belong to the next stage. Where a requirement decides something implementation should decide, say so as advice rather than blocking on it — the boundary between what and how moves with the level you are working at.
