---
name: software-design
description: Turns a settled requirements document, or a short direct request, into a Korean software design document that an implementation agent with a small reasoning budget can execute without making core decisions of its own. Reads the requirements file when one is named, grounds every environment claim in the actual repository, and fixes file paths, interfaces, failure behavior, and a runnable verification step. Use after requirements are settled and before implementation starts. Do NOT use to write requirements, to review an existing design, to write code, or for visual, UI, or graphic design of any kind.
---

# Software Design (Decisions First, Rationale Last)

**One document, two readers.** The decision sections are executed by an implementation agent that may have a small reasoning budget, so they must leave that agent no core decision to make. The closing rationale section is read by a human and by design review, so it carries the alternatives. That is the reason for the order: decisions first, rationale last.

Three rules hold over everything below.

- **Nothing enters the design that no stated requirement or named failure needs.** When you add a mechanism (a cache, an abstraction, a config knob, a table, a retry layer, an extra round trip), write in one line the concrete failure it prevents. If you cannot write that line, leave it out.
- **The decision half ends with a verification step someone can run, and that step must observe the outcome the request asked for, including any behavior or invariant that has to survive the change.** A command that passes without reaching the change — an existing suite that never exercises it — is not verification, and it leaves "it looks done" as the only signal the implementer can produce.
- **Assert no environment fact you did not verify in this repository.** A decision resting on an unverified fact is `[미결정]`, not a guess.

## Procedure

1. **Take the input.** Two shapes, and only two.
   - *A requirements file path.* Read the whole file. It is the source of record. An open `[미결정]` there is settled here only when it is a technical choice the requirements left to design; a product or intent decision is settled only by the requester, or by whoever that item names, and until then it is carried into this design's own `[미결정]` list. Record which of the two happened. Never resolve one silently.
   - *A direct request.* Restate it in one sentence. If you cannot, ask for that one missing thing and stop. Otherwise proceed, recording each gap you filled as `[가정]`. Do not run a requirements interrogation, and do not send the request back for one.
2. **Ground the decisions.** Search narrowly, then read only the range you need. Cover what the decisions actually rest on: the modules and conventions already in place, dependency versions, migration head, how tests are run and whether they currently pass, and the concrete runtime or driver behavior a decision assumes. Write each fact with the path it came from.
3. **Look outward only when a decision turns on it.** An external reference is warranted when the choice depends on a fact outside this repository: a library's actual API, a version constraint, a protocol rule. Cite what you used. **If this session has no way to look it up, do not guess** — mark the item `[미결정]` and say what it blocks. A behavior of an external system that nobody has observed gets no handling logic: mark it `[미결정]` naming the observation that would settle it. Never go reading general best practice; that is token spend with no decision attached.
4. **Decide.** Where a choice is not obvious and is expensive to reverse, weigh at least two workable options before picking one. Where the choice is obvious, one line is the whole comparison. Put the depth into the three to five decisions with the highest change cost and keep the rest short.
5. **Write the document** in Korean to `_chain/design.md` in this worktree unless the requester named another path. `_chain/` holds one chain's artifacts — requirements, design, review rounds, verification — and is never committed or ignored. When it already holds another chain's files, stop and ask; the user clears it, and this skill deletes nothing.
6. **Self-check, then report** the path.

## Output document

Korean. A few lines per section for small work; a section that removes no ambiguity is cost with no return. Omit a section that has nothing in it rather than filling it.

| # | 절 | What it fixes |
|---|---|---|
| 1 | 대상 · 범위 · 비범위 | What is built, and at least one line of what is not. Cite the requirements file path when there is one |
| 2 | 결정 | Each decision as what will be done, not why. The comparison behind it lives in 8 |
| 3 | 변경 대상 | The files to touch by path, the interfaces or signatures involved, and what must not be touched. When the work will run as several sessions — the requester asked for it, or the list is more than one session should own, said so here — close the section with **병렬 단위**: each unit named, every file this section names to touch in exactly one unit (the files it names as untouchable belong to none), the shared foundation (schema, shared types, registrations, wiring) in one unit the others depend on, and each unit's dependencies on other units. A unit whose internals this design leaves to its own session is marked 상세설계 위임; its entry becomes that session's request verbatim and its only baseline, so it states the boundary — the files it owns and the interfaces the other units call — plus what the unit must do and every requirement condition (tolerance, quality limit) that binds it; the unit's session designs the rest and never reads the parent requirements. Omit the whole list when one session will do the work |
| 4 | 데이터 · 상태 | Only when persistence is involved: ownership, transaction boundary, idempotency, migration |
| 5 | 실패 동작 | Every failure mode that can occur here among errors, duplicates, timeouts, retries, partial success, concurrent execution, and none that cannot. The requirements' stated tolerance is the ceiling: a failure the requester accepts — manual recovery, a bounded outage — gets no handling beyond what they asked for |
| 6 | 검증 | The command to run and the condition that counts as passing, reaching the requested outcome and whatever has to remain intact |
| 7 | 가정 · 미결정 | `[가정]` with what would make it wrong; `[미결정]` with its reason, who can settle it, and what it blocks. Include every item carried over from the requirements |
| 8 | 대안 비교 | The options weighed and why the chosen one won |

Sections 1 to 7 are what the implementer reads; section 8 is for the reviewer. Say so in the document, in one line above section 8, so the implementer stops there. **An item in section 7 that blocks implementation stops the work** — the implementer does not decide it.

Identifiers (`DEC-001`) only where something else refers to them. No traceability matrix.

## Minimum design

These bind the design the same way they bind the code it produces.

- Follow what this repository already does. Do not introduce a formatter, a test framework, a dependency, or a pattern the repository does not use.
- No abstraction, interface, or config knob that was not asked for. One implementation does not need a strategy layer.
- A value that differs by environment, or that has to change without a code change, goes in the repository's existing configuration path. Other constants stay inline; do not build a configuration surface for them.
- Defensive handling belongs at trust boundaries (external input, API, DB, network) and nowhere else. Do not design error handling for a case that cannot occur.
- Tests cover business logic and logic whose failure is expensive (money, data integrity, security, irreversible side effects). No coverage-driven tests, none for trivial code or framework wiring, and none of that logic left untested. A stricter repository or CI convention wins.
- Do not break out tasks or an ordered step list. That belongs to the implementation stage, and a plan that fights the implementer's own reasoning does more harm than no plan. 병렬 단위 is file ownership and order between sessions, not a step list inside one.

## Self-check

Run this over the finished draft before showing it.

- Is every decision the implementer would otherwise have to make either settled in sections 1 to 6 or listed in section 7 as blocking?
- Does section 6 reach the requested outcome, rather than pass on a suite that never exercises the change?
- Does every environment claim carry the path it was verified against?
- Is every requirements `[미결정]` either settled here with a note saying which kind of decision it was, or listed in section 7?
- Does every mechanism you added name the failure it prevents?

Anything failing the first four gets fixed. Anything failing the last one gets removed.

## Report

Three lines, nothing more: the path written, the requirements file (or 직접 요청) it was built from, and the count of open `[미결정]`. Do not paste the document into the response; the file is the artifact.

## Do not

- Do not write code, and do not modify any file other than the design document.
- Do not settle a requirements `[미결정]` without recording that you did.
- Do not restate the requirements document. Cite its path and carry over only what a decision rests on.
- Do not "improve" adjacent code, conventions, or structure that the request did not reach.
- Do not treat section count or document length as quality.
