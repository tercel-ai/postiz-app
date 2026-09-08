## Forbidden Directories

- `apps/extension/` is frozen and no longer under development.

- Do not read, modify, or review any files under this directory.

- If a task appears to be related to the extension, directly inform the user that the directory is frozen and do not proceed.

## Forbidden Operations: Direct Database Writes

- Never run `pnpm prisma-db-push` (or `prisma db push`/`prisma db execute` in any form), and never execute any SQL statement directly against a database — not even one that looks purely additive (e.g. adding a nullable column).

- This is not a style preference. `db push` reconciles the *entire* connected database to match `schema.prisma`, and with `--accept-data-loss` it does so without pausing for confirmation — any table `schema.prisma` doesn't define reads as "extra" and gets dropped. This has already happened once: a routine, seemingly-safe `db push` (adding three nullable columns to `Integration`) dropped 15 real, non-empty tables — `users`, `actions`, `tasks`, `transactions`, `credit_balances` and more, tens of thousands of rows — belonging to a completely different service.

- **The reason it reached the wrong tables: `DATABASE_URL` in `.env` pointed at another service's database.** This repo's data lives in `aisee_postiz_dev`. `aisee_dev` belongs to aisee-core (a separate Python/SQLAlchemy service, tables `users`/`actions`/`tasks`/`products`/`credit_*`/`transactions`/…). The local `.env` was pointed at `aisee_dev`, so `db push` faithfully reconciled aisee-core's database to postiz's schema: it dropped every aisee-core table and created postiz's tables there empty. Before running anything that touches a database from this repo, confirm which database the connection actually resolves to — `prisma` prints it (`Datasource "db": PostgreSQL database "…"`), and `SELECT current_database()` answers it directly. If it is not `aisee_postiz_dev`, stop and tell the user the `.env` is misconfigured.

- Schema changes may only reach the database through: (a) the user running the command themselves, or (b) the project's own deployment/migration pipeline. An agent's job stops at preparing the code — the updated `schema.prisma`, a migration SQL file under `libraries/nestjs-libraries/src/database/prisma/migrations/` documenting the change — and then explicitly telling the user what needs to be applied and how, never applying it itself.

- This applies regardless of which database the task is aimed at (dev, staging, or otherwise) and regardless of how low-risk the specific schema change looks in isolation.
