import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const startupMarker = "BACKEND_STARTUP_COMPLETE";
const timeoutMs = 15_000;
const wrappingKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const lookupKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const productionContentKeys = {
	MEETING_CONTENT_WRAPPING_KEY: wrappingKey,
	MEETING_CONTENT_LOOKUP_KEY: lookupKey,
};
const testEnv = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	NODE_ENV: "test",
	DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/startup_does_not_query",
	AUTH_JWT_SECRET: "ci_dummy_jwt_secret_0123456789",
	LIVEKIT_URL: "wss://ci.livekit.invalid",
	LIVEKIT_API_KEY: "ci_dummy_key",
	LIVEKIT_API_SECRET: "ci_dummy_secret",
	LIVEKIT_WEBHOOK_SECRET: "ci_dummy_webhook_secret",
	ASSISTANT_SERVICE_URL: "http://localhost:4100",
	ASSISTANT_SERVICE_SECRET: "ci_dummy_assistant_secret",
	API_PORT: "0",
	ASSISTANT_PORT: "0",
};

const runModule = ({ modulePath, env = {}, startServer = false }) => {
	const moduleUrl = new URL(`../../${modulePath}`, import.meta.url).href;

	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`await import(${JSON.stringify(moduleUrl)}); process.stdout.write(${JSON.stringify(`${startupMarker}\n`)}); ${startServer ? 'process.kill(process.pid, "SIGTERM");' : ""}`,
		],
		{ cwd: root, env: { ...testEnv, ...env }, encoding: "utf8", timeout: timeoutMs },
	);
};

const assertBooted = (result) => {
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, new RegExp(startupMarker));
};

const assertRejected = ({ modulePath, env, message }) => {
	const result = runModule({ modulePath, env });
	assert.equal(result.error, undefined);
	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stdout, new RegExp(startupMarker));
	assert.match(result.stderr, message);
};

test("API Railway start command migrates before serving", async () => {
	const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.scripts["start:api"], "corepack pnpm db:migrate && corepack pnpm start:api:server");
	assert.equal(pkg.scripts["build:api"], "corepack pnpm --filter @readymeet/api build");
	assert.equal(pkg.scripts["db:migrate"], "corepack pnpm --filter @readymeet/db migrate");
	assert.match(pkg.scripts.dev, /^corepack pnpm --filter @readymeet\/db generate && READYMEET_PRISMA_GENERATED=1 /);
});

test("migrate, seed, and service startup generate the Prisma client", async () => {
	const dbPkg = JSON.parse(await readFile(new URL("../../db/package.json", import.meta.url), "utf8"));
	const apiPkg = JSON.parse(await readFile(new URL("../../api/package.json", import.meta.url), "utf8"));
	const assistantPkg = JSON.parse(await readFile(new URL("../../assistant/package.json", import.meta.url), "utf8"));
	assert.match(dbPkg.scripts.migrate, /^prisma generate && /);
	assert.match(dbPkg.scripts.seed, /^prisma generate && /);
	[
		apiPkg.scripts.dev,
		apiPkg.scripts.start,
		assistantPkg.scripts.dev,
		assistantPkg.scripts["dev:watch"],
		assistantPkg.scripts.start,
	].forEach((script) => {
		assert.match(script, /^corepack pnpm --filter @readymeet\/db generate && /);
	});
});

test("backend entrypoints finish initialization before evaluating their servers", async () => {
	const api = await readFile(new URL("../../api/index.ts", import.meta.url), "utf8");
	const assistant = await readFile(new URL("../../assistant/index.ts", import.meta.url), "utf8");
	assert.match(api, /await import\("\.\/composition\/env"\);\s*await import\("\.\/composition\/server"\);/);
	assert.match(
		assistant,
		/import "openai\/shims\/web";\s*await import\("\.\/composition\/wire"\);\s*await import\("\.\/composition\/server"\);/,
	);
	assertBooted(runModule({ modulePath: "api/index.ts", startServer: true }));
	assertBooted(runModule({ modulePath: "assistant/index.ts", startServer: true }));
});

test("explicit API initialization still rejects missing, invalid and insecure configuration", () => {
	const modulePath = "api/composition/env.ts";
	assertRejected({ modulePath, env: { DATABASE_URL: undefined }, message: /DATABASE_URL/ });
	assertRejected({ modulePath, env: { DATABASE_URL: "not-a-url" }, message: /DATABASE_URL/ });
	assertRejected({
		modulePath,
		env: { NODE_ENV: "production" },
		message: /Refusing to start in production with insecure default/,
	});
	const productionSecrets = {
		NODE_ENV: "production",
		AUTH_EXCHANGE_SECRET: "startup_test_unique_exchange_secret",
		OAUTH_TOKEN_ENCRYPTION_KEY: "startup_test_unique_encryption_key",
	};
	assertRejected({
		modulePath,
		env: productionSecrets,
		message: /MEETING_CONTENT_WRAPPING_KEY/,
	});
	assertBooted(runModule({ modulePath, env: { ...productionSecrets, ...productionContentKeys } }));
	const development = runModule({ modulePath, env: { NODE_ENV: "development" } });
	assertBooted(development);
	assert.match(development.stderr, /local development key provider/);
	assert.match(development.stderr, /MEETING_CONTENT_WRAPPING_KEY/);
	assert.match(development.stderr, /MEETING_CONTENT_LOOKUP_KEY/);
	assertRejected({
		modulePath,
		env: { NODE_ENV: "development", MEETING_CONTENT_WRAPPING_KEY: "not-a-hex-key" },
		message: /MEETING_CONTENT_WRAPPING_KEY must be 64 hex characters/,
	});
});

test("explicit assistant initialization still rejects missing, invalid and insecure configuration", () => {
	const modulePath = "assistant/composition/wire.ts";
	assertRejected({ modulePath, env: { ASSISTANT_SERVICE_SECRET: undefined }, message: /ASSISTANT_SERVICE_SECRET/ });
	assertRejected({ modulePath, env: { DATABASE_URL: "not-a-url" }, message: /DATABASE_URL/ });
	assertRejected({
		modulePath,
		env: { NODE_ENV: "production" },
		message: /Set LIVEKIT_REALTIME_SERVICE_SECRET in production/,
	});
	assertRejected({
		modulePath,
		env: { NODE_ENV: "production", LIVEKIT_REALTIME_SERVICE_SECRET: "livekit_realtime_shared_secret" },
		message: /Set LIVEKIT_REALTIME_SERVICE_SECRET in production/,
	});
	const productionAssistant = {
		NODE_ENV: "production",
		API_BASE_URL: "https://api.startup.test",
		LIVEKIT_REALTIME_SERVICE_URL: "https://realtime.startup.test",
		LIVEKIT_REALTIME_SERVICE_SECRET: "startup_test_unique_realtime_secret",
	};
	assertRejected({
		modulePath,
		env: productionAssistant,
		message: /MEETING_CONTENT_WRAPPING_KEY/,
	});
	assertBooted(runModule({ modulePath, env: { ...productionAssistant, ...productionContentKeys } }));
});
