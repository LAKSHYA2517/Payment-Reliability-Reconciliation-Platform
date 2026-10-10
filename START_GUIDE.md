# Start Guide

How to run the Payment Reliability platform locally (Phase 0).

## Prerequisites

- Node.js 24 or newer (`node -v`)
- Docker Desktop, running (`docker info` should not error)
- macOS only: if the project lives in `~/Desktop` or `~/Documents`, your terminal needs permission to read it.
  System Settings > Privacy & Security > Files & Folders > enable Desktop Folder for your terminal, then fully quit and reopen it.

## First-time setup

```bash
cd payment-reliability
npm install
cp .env.example .env
```

Edit `.env` and replace `change-me` with a real password in **both** `POSTGRES_PASSWORD` and `DATABASE_URL`
(use only letters, digits, `-`, `_`, `.`, because the password is embedded in a URL).

`.env` is gitignored. Never commit it.

## Option A: everything in Docker

```bash
docker compose up -d --build
docker compose ps
curl -i localhost:3000/healthz
```

Expected: `db` and `app` show `healthy`, `migrate` shows `Exited (0)`, and curl returns `HTTP/1.1 200` with
`{"status":"ok","checks":{"app":"up","database":"up"}}`.

Useful commands:

```bash
docker compose logs -f app     # follow app logs
docker compose down            # stop everything (keeps database data)
docker compose down -v         # stop and DELETE database data
```

## Option B: app on your machine, only Postgres in Docker

Best for development, with auto-reload on file changes.

```bash
docker compose up -d db
npm run migrate:up
npm run dev
```

Then, in a second terminal:

```bash
curl -i localhost:3000/healthz
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with auto-reload (reads `.env`) |
| `npm run build` | Compile TypeScript from `src/` to `dist/` |
| `npm start` | Run the compiled server from `dist/` |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Run the tests (no database needed) |
| `npm run migrate:create -- <name>` | Create a new SQL migration file |
| `npm run migrate:up` | Apply pending migrations |
| `npm run migrate:down` | Roll back the last migration |

## Verify the setup

1. `npm test` passes (6 tests).
2. `curl -i localhost:3000/healthz` returns 200.
3. `docker compose stop db`, then curl again: returns 503 with `"database":"down"`.
4. `docker compose start db`, wait a few seconds: back to 200.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `operation not permitted` on `.env` or `process.cwd` | macOS privacy block; see Prerequisites |
| `Cannot connect to the Docker daemon` | Start Docker Desktop and wait until it is running |
| `port is already allocated` | Change `PORT` or `POSTGRES_PORT` in `.env` |
| `set POSTGRES_PASSWORD in .env` | Create `.env` with `cp .env.example .env` |
| `Invalid environment configuration` | `DATABASE_URL` is missing or not a `postgres://` URL |
| `ECONNREFUSED` from `npm run dev` | Database is not up; run `docker compose up -d db` |
