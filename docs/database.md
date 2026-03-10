# Database

## Prisma Schema Location

```
libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

All `prisma` commands must include `--schema` since the schema is not in the default location.

## Common Commands

### Sync database after schema changes (dev)

```bash
npx prisma db push --schema=libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

After modifying `schema.prisma` (adding/removing models, fields, indexes, etc.), run this command to sync the database. This is required before restarting the app, otherwise queries may fail due to missing columns/tables.

### Generate Prisma client (dev)

```bash
npx prisma generate --schema=libraries/nestjs-libraries/src/database/prisma/schema.prisma
```

Regenerate the Prisma client after schema changes. Usually done automatically during `build`, but needed if you want type-checking before building.

### Production startup

Production uses `pm2-run` which automatically runs `prisma db push` before starting the app:

```bash
pnpm run pm2-run
# Equivalent to: prisma-db-push && prisma-seed && pm2 && pm2 logs
```

No manual database sync is needed in production — it happens on every deploy.

**Important:** `pm2 restart` only restarts the process — it does NOT run `db push` or `seed`. Always use `pnpm run pm2-run` after schema changes or fresh deploys.

### Reset database (destructive)

```bash
pnpm run prisma-reset
```

Force-resets the database and re-pushes the schema. **All data will be lost.**

## Notes

- Production uses `prisma db push --accept-data-loss` (not migrations). This means schema changes are applied directly without migration files.
- The seed script (`prisma-seed`) runs after `db push` to initialize default settings (e.g., AI pricing config).
