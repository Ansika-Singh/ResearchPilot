# ResearchPilot — live demo script (3–4 minutes)

**Presenter prep:** Open the running app. Start a fresh question; do not replay a saved fixture. Have the project database/model/search configured. If a tool errors, leave the recovery event visible and explain the partial-evidence path—do not replace it with mock results.

## 0:00–0:20 — Problem

“Most research chatbots hide how they got to an answer. ResearchPilot exposes the decision process: what it planned, what it actually searched, what it observed, when it changed course, and whether the report passed verification.”

## 0:20–0:40 — New research goal

Type a novel query, for example:

> “Should our college run an in-person, two-day AI/ML workshop for 200 students? Find comparable university events and costs. If search results are online or outside India, revise the plan toward in-person Indian college events. Calculate the cost at ₹500 per student plus ₹25,000 instructor fees; finish with a verified action plan.”

Add constraints separately if the judge provides them. Select **Start research**. Point out that the session ID, question and empty, honest source state appear immediately.

## 0:40–1:15 — Planner and tool selection

Expand **Planner**. Show the actual returned plan and its step criteria. While the run is active, point to **Decision**. Explain that a strict-JSON model action is validated by the backend before tool dispatch; this is not a UI animation and the user did not choose the search query or tool.

When **Tool / live web search** appears, expand it. Call out the backend-generated query and the DuckDuckGo provider. Then open one source in the evidence panel and distinguish a search-result snippet from a page extraction.

## 1:15–1:55 — Observation, evidence and change of route

Open **Observation**. Read the model’s actual summary and gaps. If it identifies a location/format mismatch, point to **Re-plan** and compare the previous and updated plan side by side. If the initial evidence matches, use the actual gap the agent reports instead—do not manufacture a mismatch or edit the run.

Explain that the next decision receives the updated state, new source IDs and unresolved requirements, not just the original prompt.

## 1:55–2:25 — Calculation and verification

When the calculator action appears, expand it to show the arithmetic expression and deterministic result. Explain the distinction between calculated inputs and externally supported prices. Show **Verification** only after the agent has processed the current plan and evidence. If verification fails, its issues should trigger a re-plan/research cycle, up to the safety bound.

## 2:25–3:15 — Final report

Show the completed report and session metrics: actual plan steps, tool calls, live sources, re-plans, elapsed time and verification status. Open the source list to demonstrate URL-to-evidence provenance. Copy or export the Markdown.

## 3:15–3:45 — Why it is agentic

“The model plans, but cannot execute arbitrary code. A backend state machine validates each tool decision, executes the selected tool, stores the observation, and asks for the next decision. Evidence changes the plan; a verifier gates synthesis; and the whole trace is persisted and replayable. You can see every transition in the browser because the server streams the event that just occurred.”

## Judge questions to invite

- “Why was that action chosen over another tool?” Expand its **Decision** event.
- “What did the source actually say?” Expand the source’s extraction or evidence.
- “What happens when evidence is missing?” Expand the observation/re-plan events.
- “Can I enter a different question?” Start a second genuinely fresh run.
