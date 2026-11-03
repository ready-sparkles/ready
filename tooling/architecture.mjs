export const files = [
	{ category: "test", pattern: "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}" },
	{ category: "test", pattern: "**/tests/**" },
	{ category: "tooling", pattern: "tooling/**" },
	{ category: "tooling", pattern: "**/*.config.{ts,mts,cts,js,mjs,cjs}" },
	{ category: "tooling", pattern: "{web,api,assistant,db,shared,openai-responses}/scripts/**" },
	{ category: "tooling", pattern: "scripts/**" },
	{ category: "tooling", pattern: "web/adapters/primary/outlook/{manifest,build-formatter}.mjs" },
	{ category: "tooling", pattern: "web/next-env.d.ts" },
	{ category: "generated", pattern: "db/generated/**" },
	{ category: "next-http", pattern: "web/app/**/route.ts" },
	{ category: "next-http", pattern: "web/middleware.ts" },
	{ category: "composition", pattern: "web/auth.ts" },
	{ category: "presentation", pattern: "web/app/**/*.tsx" },
	{ category: "google-script", pattern: "web/adapters/primary/google-calendar/Code.js" },
	{ category: "composition", pattern: "db/index.ts" },
	{ category: "composition", pattern: "db/migrate.ts" },
	{ category: "composition", pattern: "db/seed.ts" },
	{ category: "domain", pattern: "shared/index.ts" },
	{ category: "composition", pattern: "assistant/index.ts" },
	{ category: "composition", pattern: "api/index.ts" },
	{ category: "composition", pattern: "api/memory-worker-entry.ts" },
].map((descriptor) => ({ ...descriptor, exclusive: true }));

export const elements = [
	{ type: "primary", pattern: "web/public/outlook", partialMatch: false },
	...["primary", "secondary"].map((type) => ({
		type,
		pattern: `*/adapters/${type}/*`,
		capture: ["package", "adapter"],
		partialMatch: false,
	})),
	...["domain", "ports", "application", "composition", "presentation"].map((type) => ({
		type,
		pattern: `*/${type}`,
		capture: ["package"],
		partialMatch: false,
	})),
];

export const dependencies = {
	domain: ["domain"],
	ports: ["domain", "ports"],
	application: ["domain", "ports", "application"],
	primary: ["application", "ports", "domain", "composition"],
	secondary: ["ports", "domain"],
	composition: ["application", "ports", "domain", "primary", "secondary", "composition"],
	presentation: ["presentation", "composition", "domain"],
	test: ["*"],
	tooling: ["*"],
};

export const externalDependencies = {
	domain: ["zod", "tldts"],
	ports: ["zod"],
	application: ["zod"],
	primary: [
		"zod",
		"node:http",
		"node:buffer",
		"fastify",
		"@fastify/cors",
		"@fastify/rate-limit",
		"next-auth",
		"next-auth/*",
	],
	secondary: [
		"zod",
		"node:crypto",
		"node:buffer",
		"node:fs",
		"node:fs/promises",
		"node:path",
		"node:url",
		"node:os",
		"node:dns",
		"node:dns/promises",
		"node:net",
		"node:stream",
		"node:stream/web",
		"node:util",
		"pg",
		"@prisma/adapter-pg",
		"@prisma/client",
		"@prisma/client/*",
		"prisma",
		"prisma/*",
		"dotenv",
		"dotenv/config",
		"@sentry/node",
		"ably",
		"htmlparser2",
		"jose",
		"jsonwebtoken",
		"livekit-server-sdk",
		"pino",
		"stripe",
		"undici",
		"openai",
		"ai",
		"@ai-sdk/openai",
		"@livekit/protocol",
		"idb-keyval",
		"next-auth",
		"next-auth/*",
	],
	composition: [
		"zod",
		"dotenv",
		"dotenv/config",
		"fastify",
		"@fastify/cors",
		"@fastify/rate-limit",
		"@sentry/node",
		"pino",
		"next-auth",
		"next-auth/*",
		"react",
		"@tanstack/react-query",
		"@tanstack/react-query-persist-client",
		"@tanstack/query-async-storage-persister",
	],
	presentation: [
		"react",
		"react-dom",
		"react-dom/*",
		"react/jsx-runtime",
		"next",
		"next/link",
		"next/navigation",
		"next/image",
		"next/font/*",
		"next/headers",
		"next-auth/react",
		"@dnd-kit/core",
		"@dnd-kit/sortable",
		"@dnd-kit/utilities",
		"@livekit/components-react",
		"@livekit/track-processors",
		"@mediapipe/tasks-vision",
		"@tanstack/react-query",
		"@tanstack/react-query-persist-client",
		"@tanstack/query-async-storage-persister",
		"livekit-client",
		"metal-fx",
		"motion",
		"motion/react",
		"thinking-orbs",
		"voice-glow",
	],
};

const categoriesForRole = (role) => (role === "primary" ? ["next-http", "google-script"] : [role]);
const selectRole = (role) => [{ element: { type: role } }, { file: { categories: categoriesForRole(role) } }];

export const dependencyPolicies = [
	// Check internal edges too: a colocated test must not inherit its folder's product role.
	{ dependency: { relationship: { to: "internal" } }, allow: { to: { module: { origin: "local" } } } },
	{
		from: { file: { categories: "next-http" } },
		allow: {
			to: { element: { type: "primary", captured: { package: "web", adapter: "next-http" } } },
		},
	},
	{
		from: { element: { type: "primary", captured: { package: "web", adapter: "next-http" } } },
		allow: { to: { file: { categories: "next-http" } } },
	},

	// HTTP handlers call these existing provider operations directly, without export-only bridges.
	...[
		{
			packageName: "api",
			targets: [
				"ashby/ashby-client.ts",
				"ashby/ashby-profile-links.ts",
				"ashby/ashby-review-service.ts",
				"jose/google-id-token.ts",
				"livekit/call-in-waiting-room.ts",
				"livekit/livekit-participant-presence.ts",
				"livekit/livekit.ts",
				"livekit/sdk.ts",
				"node/secret-crypto.ts",
				"slack/slack-client.ts",
				"slack/slack-connection.ts",
				"slack/slack-review-service.ts",
				"stripe/stripe-billing.ts",
				"stripe/stripe-client.ts",
				"stripe/workspace-stripe-billing.ts",
				"undici/assistant-client.ts",
			],
		},
		{
			packageName: "assistant",
			targets: [
				"livekit/agent-dispatch-manager.ts",
				"livekit/realtime-event-processor.ts",
				"livekit/transcription-manager.ts",
			],
		},
	].map(({ packageName, targets }) => ({
		from: {
			element: { type: "primary", captured: { package: packageName, adapter: "http" } },
		},
		allow: {
			to: { file: { path: targets.map((target) => `${packageName}/adapters/secondary/${target}`) } },
		},
	})),
	{
		from: { file: { path: "db/ports/repository.ts" } },
		dependency: { kind: "type" },
		allow: {
			to: {
				file: {
					path: [
						"db/index.ts",
						"db/adapters/secondary/postgres/ashby.ts",
						"db/adapters/secondary/postgres/meeting-call-in-lock.ts",
						"db/adapters/secondary/postgres/repositories.ts",
						"db/adapters/secondary/postgres/relationship-memory.ts",
						"db/adapters/secondary/postgres/slack-review.ts",
					],
				},
			},
		},
	},
	...Object.entries(dependencies).map(([role, allowed]) => ({
		from: selectRole(role),
		allow: { to: allowed.flatMap(selectRole) },
	})),
	...Object.entries(externalDependencies).map(([role, allowed]) => ({
		from: selectRole(role),
		allow: { to: { module: { origin: ["external", "core"], source: allowed } } },
	})),
	{
		from: [
			{ element: { type: "primary", captured: { package: "web", adapter: "next-http" } } },
			{ file: { categories: "next-http", path: ["web/app/**/route.ts", "web/middleware.ts"] } },
		],
		dependency: { source: ["next/headers", "next/server"] },
		allow: { to: { module: { origin: "external", source: "next" } } },
	},
	{
		from: {
			element: {
				type: "secondary",
				captured: { package: "web", adapter: "browser-query-cache" },
			},
		},
		dependency: { source: "@tanstack/react-query" },
		allow: { to: { module: { origin: "external", source: "@tanstack/react-query" } } },
	},
	...[
		{
			element: { type: "application", captured: { package: "api" } },
			modules: ["node:crypto", "node:dns/promises", "node:fs/promises", "node:net", "node:os", "node:path"],
		},
		{
			element: { type: "application", captured: { package: "assistant" } },
			modules: ["node:crypto"],
		},
		{
			element: { type: "primary", captured: { package: "api", adapter: "http" } },
			modules: ["node:crypto"],
		},
	].map(({ element, modules }) => ({
		from: { element },
		dependency: { source: modules },
		// Boundaries normalizes promise subpaths to node:fs/node:dns; the dependency source stays exact.
		allow: { to: { module: { origin: "core", source: modules.map((source) => source.split("/")[0]) } } },
	})),
	{
		from: { file: { path: "api/composition/a-configure.ts" } },
		dependency: { source: ["node:path", "node:url"] },
		allow: { to: { module: { origin: "core", source: ["node:path", "node:url"] } } },
	},
	{
		from: { file: { path: "api/adapters/secondary/memory-process/child-process.ts" } },
		dependency: { source: "node:child_process" },
		allow: { to: { module: { origin: "core", source: "node:child_process" } } },
	},
	{
		from: { file: { path: "db/adapters/secondary/postgres/migrations.ts" } },
		dependency: { source: "node:child_process" },
		allow: { to: { module: { origin: "core", source: "node:child_process" } } },
	},
	{
		from: { element: { type: "secondary", captured: { package: "db", adapter: "postgres" } } },
		allow: { to: { file: { categories: "generated" } } },
	},
	{
		from: { file: { categories: "generated" } },
		allow: { to: { module: { origin: ["local", "external", "core"] } } },
	},
	{
		from: { file: { path: "assistant/adapters/secondary/observability/logger.ts" } },
		dependency: { source: "node:console" },
		allow: { to: { module: { origin: "core", source: "node:console" } } },
	},
	{
		from: { file: { path: "assistant/index.ts" } },
		dependency: { source: "openai/shims/web" },
		allow: { to: { module: { origin: "external", source: "openai" } } },
	},
	{
		from: {
			element: {
				type: "secondary",
				captured: { package: "assistant", adapter: "openai" },
			},
		},
		allow: {
			to: {
				element: {
					type: "secondary",
					captured: { package: "openai-responses", adapter: "vercel" },
				},
			},
		},
	},
	{
		from: { module: { origin: "local" } },
		disallow: { to: { file: { categories: ["test", "tooling"] } } },
	},
	...["test", "tooling"].map((role) => ({
		from: selectRole(role),
		allow: { to: { module: { origin: ["local", "external", "core"] } } },
	})),
];
