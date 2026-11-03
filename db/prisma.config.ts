import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, env } from "prisma/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(packageRoot);

config({ path: path.join(workspaceRoot, ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  experimental: {
    externalTables: true,
  },
  tables: {
    external: ["public.schema_migrations"],
  },
  datasource: {
    url: env("DATABASE_URL"),
    // Required by `prisma migrate dev` and `migrate diff --from-migrations`; see db/MIGRATIONS.md.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
