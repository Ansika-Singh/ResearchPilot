# ResearchPilot configuration

ResearchPilot never needs a search API key: the included search adapter queries DuckDuckGo's public HTML endpoint. The managed WebDev deployment uses the platform-provided server-side model credentials and database connection. Do not copy those secrets into browser code.

## Local Node.js setup

Create a `.env` file from the following values (do not check it into Git):

```dotenv
LLM_PROVIDER=openai_compatible
LLM_MODEL=gpt-5-mini
LLM_BASE_URL=https://your-compatible-provider.example/v1
LLM_API_KEY=replace-with-your-private-key
RESEARCH_STORAGE=sqlite
RESEARCH_DB_PATH=./data/researchpilot.sqlite
```

Use a model available from your chosen provider; strict JSON-schema output is required. The model shown is only an example for a compatible provider. Local execution does not inherit a Manus account's server credentials.

Alternatively, inside the managed WebDev project, keep `LLM_PROVIDER=manus_builtin` (the default), where the project resolves its configured server-side built-in model catalog. Omit `LLM_API_KEY` and do not expose the platform's built-in key to the frontend.

## Storage settings

| Variable | Accepted value | Behavior |
| --- | --- | --- |
| `RESEARCH_STORAGE` | `sqlite` | Use Node 22 built-in SQLite at `RESEARCH_DB_PATH` |
| `RESEARCH_STORAGE` | `mysql` | Use the deployment `DATABASE_URL` through Drizzle |
| `RESEARCH_STORAGE` | unset | SQLite when no `DATABASE_URL` is present; otherwise managed database |
| `RESEARCH_DB_PATH` | filesystem path | Optional; defaults to `./data/researchpilot.sqlite` |

## Run and verify

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` and submit a fresh question. The history includes the actual event list, source IDs and verification result. For the container setup, create the same private `.env` file beside `docker-compose.yml` and run `docker compose up --build`.

## Secret-handling notes

- Never put LLM credentials in any `VITE_*` variable: Vite variables are compiled into browser-visible assets.
- Do not commit `.env`, database files, user research, or uploads.
- In production, authenticate sessions, enforce ownership checks, apply rate limits, and use a managed persistent database.
