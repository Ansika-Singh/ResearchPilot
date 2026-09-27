# ResearchPilot project TODO

## Implemented features

- [x] Structured planner and one-action-at-a-time decision loop with strict JSON schemas.
- [x] Real DuckDuckGo HTML search, public URL extraction, safe calculator, and bounded CSV/JSON/TXT/Markdown reader.
- [x] Tool observations feed current state; mismatches and verification failures can trigger bounded re-planning.
- [x] Independent verification gate before final synthesis; unsupported evidence is reported rather than invented.
- [x] Live SSE trace, reconnect/replay, source panel, report export, and persisted run history.
- [x] Local SQLite and managed MySQL persistence.
- [x] Bounded model/tool requests and an explicit interrupted-session state after server restarts.
- [x] Server-only provider credentials; no browser-side MCP/tool access.

## Final acceptance work

- [x] Run the full Vitest suite, TypeScript check, and production build after the latest search recovery changes.
- [ ] Submit a fresh live research question in the running UI; inspect the actual Planner → Tool → Observation → Decision → Re-plan (if justified) → Verification → Final Report events.
- [ ] Run a second, distinct fresh question and confirm history can reopen it.
- [ ] Exercise a live failure/recovery path or confirm the deterministic integration test covers it without mixing mock results into real runs.
- [ ] Capture a real UI/trace screenshot and add a link/caption in the README.
- [ ] Save the final managed WebDev checkpoint after verification.

## Known follow-up risks (not fake-completed)

- [ ] Add user ownership checks and request-level rate limits before exposing private research sessions to the public internet.
- [ ] For production multi-instance hosting, replace process-local SSE pub/sub with a shared event broker and use a durable database configuration.
- [ ] Public search HTML can change or be rate-limited; errors are surfaced, bounded, and never replaced with fabricated sources.
- [ ] Review the target hosting plan to ensure it forwards SSE responses rather than buffering them.
