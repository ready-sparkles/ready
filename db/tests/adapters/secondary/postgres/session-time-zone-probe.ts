// Spawned by session-time-zone.test.ts with DATABASE_URL pointing at a non-UTC session.
import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import { upsertUser } from "../../../../index";

export const SESSION_TIME_ZONE_RESULT_MARKER = "SESSION_TIME_ZONE_RESULT ";
const PROBE_DISPLAY_NAME = "TZ probe";
const MS_PER_SECOND = 1000;

async function probe(): Promise<void> {
  const user = await upsertUser({
    email: `tz-probe-${String(Date.now())}@example.test`,
    displayName: PROBE_DISPLAY_NAME,
    source: "auth",
  });
  const rows = await db.$queryRaw<{ zone: string; age: number }[]>`
    SELECT current_setting('TimeZone') AS zone, EXTRACT(EPOCH FROM (now() - created_at))::float8 AS age
    FROM users WHERE id = CAST(${user.id} AS uuid)`;
  const read = await db.users.findUniqueOrThrow({ where: { id: user.id }, select: { createdAt: true } });
  await db.users.delete({ where: { id: user.id } });
  await closeDbPool();
  const [row] = rows;
  process.stdout.write(
    `${SESSION_TIME_ZONE_RESULT_MARKER}${JSON.stringify({
      zone: row?.zone,
      age: row?.age,
      jsSkew: (Date.now() - read.createdAt.getTime()) / MS_PER_SECOND,
    })}\n`,
  );
}

if (process.env.SESSION_TIME_ZONE_PROBE === "1") {
  await probe();
}
