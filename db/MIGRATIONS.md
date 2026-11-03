# Database migrations

`db:migrate` (and `start:api`) applies migrations: the runner in
`adapters/secondary/postgres/migrations.ts` installs or adopts the `0_init` baseline itself, then
runs `prisma migrate deploy` for every later directory in `prisma/migrations/`.

## Adding a migration

1. Edit `prisma/schema.prisma`.
2. Generate the SQL from your schema change:

   ```sh
   corepack pnpm db:migration:new add_meeting_tags
   ```

   This runs `prisma migrate dev --create-only` against a shadow database and saves the result as
   the next numbered directory (for example `prisma/migrations/0137_add_meeting_tags/migration.sql`).
   It does not touch your development data.
3. Review the SQL. Add anything Prisma cannot express (functions, triggers, data backfills).
4. Apply it with `corepack pnpm db:migrate`.

The shadow database is `SHADOW_DATABASE_URL`, or `<your database>_shadow` on the same server. The
script creates it when missing, so your database role needs `CREATEDB` (local and CI Postgres do).

Plain `prisma migrate dev` and `prisma migrate diff --from-migrations` work too, as long as
`SHADOW_DATABASE_URL` points at a database prepared with:

```sql
CREATE DATABASE readymeet_shadow;
ALTER DATABASE readymeet_shadow SET check_function_bodies = off;
```

### Why the shadow database needs `check_function_bodies = off`

`0_init/migration.sql` is a `pg_dump` that relies on `SET LOCAL check_function_bodies = false`. Our
runner applies it inside a transaction, where that works. Prisma replays migrations into the
shadow database outside a transaction, so `SET LOCAL` is ignored and PL/pgSQL functions that
reference tables created later in the file fail (`relation "meetings" does not exist`). Every
deployed database has the checksum of `0_init` recorded in `_prisma_migrations`, so editing the
file would make `migrate deploy` report a modified migration. The setting lives on the shadow
database instead.

`prisma.config.ts` lists the runner's own `public.schema_migrations` table as external. Prisma 7
requires the schema-qualified name (`P3023` otherwise), and the external entry keeps Prisma from
generating a `DROP TABLE` for it.

`tests/migration-authoring.test.ts` replays every migration into a fresh shadow database and fails
when `schema.prisma` has changes that no migration covers.

## Preserving existing meeting content for migration 0137

Ordinary `db:migrate` refuses protected rows until they have been converted. Use the
explicit maintenance command documented in `docs/meeting-content-encryption.md`, with
all production readers/writers stopped and a usable backup. It uses the existing
baseline-adoption and migration lock, then executes pending prerequisites, 0137's
expansion, content conversion, verification, final constraints, and its Prisma history
marker in one PostgreSQL transaction. The ordinary empty-install SQL keeps its guard.
The two SQL comments `CONTENT_EXPAND` and `CONTENT_FINALIZE` delimit the same migration
statements for that operator-only path. No additional migration/release is required.

Never change a migration already applied in a shared database. The cutover command
refuses an applied 0137, failed migration history, or unexpected later migration.
Disposable local databases using an earlier unmerged 0137 can be recreated.
