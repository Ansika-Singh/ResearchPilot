# ResearchPilot — five-slide presentation content

## Slide 1 — The problem: answers without an audit trail

- Chat interfaces collapse planning, browsing, assumptions and uncertainty into one answer.
- Judges cannot tell whether tools ran, sources support claims, or the system changed course.
- **Goal:** make the decision process inspectable, repeatable and evidence-first.

## Slide 2 — ResearchPilot: question to verified decision

- Enter an arbitrary research goal and optional constraints or a data file.
- See the agent decompose work, select tools, observe actual outputs and revise its plan when evidence shifts.
- Receive an evidence-grounded report, source panel, metrics and replayable session history.
- **Live acceptance:** fresh question → Planner → Tool → Observation → Decision → conditional Re-plan → Verification → Final Report.

## Slide 3 — An explainable agent architecture

- Typed session state with plans, evidence, source IDs, tool records, decisions, verifier issues and metrics.
- Original bounded orchestration loop; no arbitrary model-generated code.
- Server-side model interface + validated search, public URL extractor, calculator and file reader.
- Real backend SSE trace; local SQLite or managed database snapshots.

## Slide 4 — Evidence, safety and verification

- Strict JSON-schema outputs at planning, action-selection, observation, re-plan and verification stages.
- Every tool input is validated and dispatched through a closed allowlist.
- Safe calculator; private/local URL blocking; bounded network/file sizes and iteration limits.
- Verifier checks completion, source support, relevance, contradictions, calculations and uncertainty.
- Verification failure triggers another bounded research cycle; synthesis is gated on PASS.

## Slide 5 — Demo proof and next steps

- Demonstrate a genuinely fresh run in the live application; open one tool decision, observation, plan change and source.
- Show calculator result, verification status, report and stored session metrics.
- **Impact:** judges can inspect not just what the agent concluded, but why and how it got there.
- Next: authenticated ownership for public deployments, stronger search-provider APIs, PDF ingestion, richer CSV statistics and independent agent-loop evaluation.
