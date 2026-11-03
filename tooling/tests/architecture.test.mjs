import { ESLint } from "eslint";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createLintConfiguration } from "../eslint.config.mjs";

process.env.TSESTREE_SINGLE_RUN = "false";
const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "readymeet-lint-policy-")));
after(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});
const paths = {
	domain: "web/domain/lintPolicyFixture.ts",
	dbAccountCoordination: "db/adapters/secondary/postgres/account-coordination.ts",
	dbRequestResult: "db/adapters/secondary/postgres/request-result.ts",
	ignoredDomain: "web/domain/dist/fixture.ts",
	moduleDomain: "shared/domain/fixture.mts",
	commonDomain: "shared/domain/fixture.cts",
	apiPorts: "api/ports/fixture.ts",
	apiHttp: "api/adapters/primary/http/fixture.ts",
	apiOtherHttp: "api/adapters/primary/other-http/fixture.ts",
	apiCryptoOperation: "api/adapters/secondary/node/secret-crypto.ts",
	apiCryptoNeighbor: "api/adapters/secondary/node/secret-crypto-helper.ts",
	assistantHttp: "assistant/adapters/primary/http/fixture.ts",
	assistantDispatch: "assistant/adapters/secondary/livekit/agent-dispatch-manager.ts",
	assistantDispatchNeighbor: "assistant/adapters/secondary/livekit/agent-dispatch-helper.ts",
	apiIndex: "api/index.ts",
	apiMemoryEntry: "api/memory-worker-entry.ts",
	apiIndexNeighbor: "api/index-helper.ts",
	apiMemoryNeighbor: "api/memory-worker-entry-helper.ts",
	apiComposition: "api/composition/fixture.ts",
	apiDomain: "api/domain/fixture.ts",
	apiApplication: "api/application/fixture.ts",
	apiConfigure: "api/composition/a-configure.ts",
	apiChildProcess: "api/adapters/secondary/memory-process/child-process.ts",
	apiChildProcessNeighbor: "api/adapters/secondary/memory-process/neighbor.ts",
	apiOtherChildProcess: "api/adapters/secondary/other/child-process.ts",
	assistantChildProcess: "assistant/adapters/secondary/memory-process/child-process.ts",
	assistantPorts: "assistant/ports/fixture.ts",
	assistantLogger: "assistant/adapters/secondary/observability/logger.ts",
	assistantOpenAI: "assistant/adapters/secondary/openai/fixture.ts",
	assistantLoggerNeighbor: "assistant/adapters/secondary/observability/neighbor.ts",
	assistantOtherLogger: "assistant/adapters/secondary/other/logger.ts",
	assistantApplication: "assistant/application/fixture.ts",
	assistantDomain: "assistant/domain/fixture.ts",
	apiLogger: "api/adapters/secondary/observability/logger.ts",
	colocatedTooling: "web/domain/fixture.config.ts",
	colocatedPageTest: "web/app/fixture/page.test.tsx",
	secondaryTest: "web/adapters/secondary/random/fixture.test.ts",
	crossPrimary: "api/adapters/primary/web/fixture.ts",
	ports: "web/ports/lintPolicyFixture.ts",
	application: "web/application/lintPolicyFixture.ts",
	primary: "web/adapters/primary/web/lintPolicyFixture.ts",
	secondary: "web/adapters/secondary/random/lintPolicyFixture.ts",
	otherSecondary: "web/adapters/secondary/fixed/lintPolicyFixture.ts",
	browserQueryCache: "web/adapters/secondary/browser-query-cache/fixture.ts",
	nestedBrowserQueryCache: "web/adapters/secondary/browser-query-cache/nested/fixture.ts",
	browserQueryCacheNeighbor: "web/adapters/secondary/browser-query-cache-helper/fixture.ts",
	otherPackageBrowserQueryCache: "other-web/adapters/secondary/browser-query-cache/fixture.ts",
	composition: "web/composition/lintPolicyFixture.ts",
	presentation: "web/presentation/lintPolicyFixture.tsx",
	sameSecondary: "web/adapters/secondary/random/another.ts",
	crossSecondary: "api/adapters/secondary/random/fixture.ts",
	otherPrimary: "web/adapters/primary/other/fixture.ts",
	nextPrimary: "web/adapters/primary/next-http/fixture.ts",
	nextAuthCallbacks: "web/adapters/primary/next-http/auth-callbacks.ts",
	nextOAuthMiddleware: "web/adapters/primary/next-http/oauth-middleware.ts",
	crossNextPrimary: "api/adapters/primary/next-http/fixture.ts",
	samePrimary: "web/adapters/primary/web/another.ts",
	webAuth: "web/auth.ts",
	webMiddleware: "web/middleware.ts",
	webAuthNeighbor: "web/auth-helper.ts",
	webMiddlewareNeighbor: "web/middleware-helper.ts",
	assistantEntry: "assistant/index.ts",
	assistantNeighbor: "assistant/index-helper.ts",
	assistantComposition: "assistant/composition/fixture.ts",
	assistantOtherComposition: "assistant/composition/other.ts",
	addonNeighbor: "web/adapters/primary/google-calendar/wrapper.js",
	db: "db/index.ts",
	dbMigrate: "db/migrate.ts",
	dbSeed: "db/seed.ts",
	dbMigrateNeighbor: "db/migrate-helper.ts",
	dbSeedNeighbor: "db/seed-helper.ts",
	dbComposition: "db/composition/fixture.ts",
	dbAdapter: "db/adapters/secondary/postgres/fixture.ts",
	dbRepositoryTypes: "db/ports/repository.ts",
	dbPorts: "db/ports/fixture.ts",
	dbAshby: "db/adapters/secondary/postgres/ashby.ts",
	dbCallIn: "db/adapters/secondary/postgres/meeting-call-in-lock.ts",
	dbRepositories: "db/adapters/secondary/postgres/repositories.ts",
	dbRelationshipMemory: "db/adapters/secondary/postgres/relationship-memory.ts",
	dbSlackReview: "db/adapters/secondary/postgres/slack-review.ts",
	openaiResponses: "openai-responses/adapters/secondary/vercel/responses.ts",
	dbMigrations: "db/adapters/secondary/postgres/migrations.ts",
	sharedDomain: "shared/domain/fixture.ts",
	sharedPorts: "shared/ports/fixture.ts",
	route: "web/app/api/fixture/route.ts",
	routeNeighbor: "web/app/api/fixture/custom-route.ts",
	nextAdapterRoute: "web/adapters/primary/next-http/fixture/route.ts",
	page: "web/app/fixture/page.tsx",
	publicWrapper: "web/public/outlook/fixture.js",
	addon: "web/adapters/primary/google-calendar/Code.js",
	addonDomain: "web/domain/google-calendar/fixture.js",
	addonSecondary: "web/adapters/secondary/apps-script/fixture.js",
	colocatedTest: "web/domain/fixture.test.ts",
	tooling: "tooling/fixture.ts",
	unknown: "web/unclassified/lintPolicyFixture.ts",
};
await Promise.all(
	Object.values(paths).map(async (path) => {
		await mkdir(dirname(join(fixtureRoot, path)), { recursive: true });
		await writeFile(
			join(fixtureRoot, path),
			path.endsWith(".js") ? "export const fixture = 1;\n" : "export type Fixture = number;\n",
			{ flag: "wx" },
		);
	}),
);
await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(fixtureRoot, "node_modules"), "dir");
await Promise.all(
	["web", "db", "shared", "api", "assistant"].map(async (workspace) => {
		await mkdir(join(fixtureRoot, workspace), { recursive: true });
		await symlink(
			fileURLToPath(new URL(`../../${workspace}/node_modules`, import.meta.url)),
			join(fixtureRoot, workspace, "node_modules"),
			"dir",
		);
	}),
);
// Give the other-package negative a real installed dependency, not an unresolved-import failure.
await symlink(
	fileURLToPath(new URL("../../web/node_modules", import.meta.url)),
	join(fixtureRoot, "other-web/node_modules"),
	"dir",
);
await writeFile(
	join(fixtureRoot, "tsconfig.eslint.json"),
	JSON.stringify({
		compilerOptions: {
			strict: true,
			noEmit: true,
			allowJs: true,
			jsx: "react-jsx",
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			baseUrl: ".",
			paths: {
				"@readymeet/db": ["db/index.ts"],
				"@readymeet/db/*": ["db/*"],
				"@readymeet/shared/*": ["shared/*"],
				"@readymeet/openai-responses": ["openai-responses/adapters/secondary/vercel/responses.ts"],
				"@/*": ["web/*"],
			},
		},
		include: ["**/*"],
	}),
);
const eslint = new ESLint({
	cwd: fixtureRoot,
	overrideConfigFile: true,
	overrideConfig: createLintConfiguration(fixtureRoot),
});
const check = async ({ filePath, code, shouldFail, rule = "boundaries/dependencies" }) => {
	const [result] = await eslint.lintText(code, { filePath });
	assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
	assert.equal(
		result.messages.some((message) => message.ruleId === null),
		false,
		JSON.stringify(result.messages),
	);
	assert.equal(
		result.messages.some((message) => message.ruleId === rule && message.severity === 2),
		shouldFail,
		JSON.stringify({ filePath, code, messages: result.messages }),
	);
	if (["policy/validated-input", "policy/named-parameters"].includes(rule)) {
		assert.equal(
			result.messages.some((message) => message.ruleId === "import/no-unresolved"),
			false,
			JSON.stringify(result.messages),
		);
	}
	if (rule === "boundaries/dependencies") {
		assert.equal(
			result.messages.some(
				(message) =>
					message.ruleId === "import/no-unresolved" ||
					message.ruleId === "boundaries/no-ignored-dependencies",
			),
			false,
			JSON.stringify(result.messages),
		);
		assert.equal(
			result.messages.some((message) => message.ruleId === "boundaries/no-unknown-files"),
			false,
			JSON.stringify(result.messages),
		);
		assert.equal(
			result.messages.some((message) => message.ruleId === "boundaries/no-unknown-dependencies"),
			false,
			JSON.stringify(result.messages),
		);
	}
};

test("domain cannot import application, ports, adapters or composition", async () => {
	await Promise.all(
		[
			"../application/lintPolicyFixture.ts",
			"../ports/lintPolicyFixture.ts",
			"../adapters/secondary/random/lintPolicyFixture.ts",
			"../composition/lintPolicyFixture.ts",
		].map((target) => check({ filePath: paths.domain, code: `import '${target}';`, shouldFail: true })),
	);
	await check({ filePath: paths.domain, code: "export const value = 1;", shouldFail: false });
});

test("ports may use domain but not application", async () => {
	await check({ filePath: paths.ports, code: "import '../domain/lintPolicyFixture.ts';", shouldFail: false });
	await check({ filePath: paths.ports, code: "import '../application/lintPolicyFixture.ts';", shouldFail: true });
});

test("only the repository type facade may derive types from exact DB implementation owners", async () => {
	await Promise.all(
		[
			"../index.ts",
			"../adapters/secondary/postgres/ashby.ts",
			"../adapters/secondary/postgres/meeting-call-in-lock.ts",
			"../adapters/secondary/postgres/repositories.ts",
			"../adapters/secondary/postgres/relationship-memory.ts",
			"../adapters/secondary/postgres/slack-review.ts",
		].map(async (target) => {
			await check({
				filePath: paths.dbRepositoryTypes,
				code: `import type { Fixture } from '${target}'; export type Derived = Fixture;`,
				shouldFail: false,
			});
			await check({
				filePath: paths.dbRepositoryTypes,
				code: `export type { Fixture } from '${target}';`,
				shouldFail: false,
			});
			await check({ filePath: paths.dbRepositoryTypes, code: `import '${target}';`, shouldFail: true });
			await check({
				filePath: paths.dbRepositoryTypes,
				code: `export { Fixture } from '${target}';`,
				shouldFail: true,
			});
			await check({
				filePath: paths.dbPorts,
				code: `export type { Fixture } from '${target}';`,
				shouldFail: true,
			});
		}),
	);
	await check({
		filePath: paths.dbRepositoryTypes,
		code: "export type { Fixture } from '../adapters/secondary/postgres/fixture.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiPorts,
		code: "export type { Fixture } from '../../db/index.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiApplication,
		code: "export type { Fixture } from '../../db/adapters/secondary/postgres/repositories.ts';",
		shouldFail: true,
	});
});

test("application may use a port but not a concrete adapter", async () => {
	await check({ filePath: paths.application, code: "import '../ports/lintPolicyFixture.ts';", shouldFail: false });
	await check({ filePath: paths.application, code: "import '../domain/lintPolicyFixture.ts';", shouldFail: false });
	await check({
		filePath: paths.application,
		code: "import '../adapters/secondary/random/lintPolicyFixture.ts';",
		shouldFail: true,
	});
});

test("composition may connect application, ports and both adapter roles", async () => {
	await check({
		filePath: paths.composition,
		code: [
			"../application/lintPolicyFixture.ts",
			"../ports/lintPolicyFixture.ts",
			"../adapters/secondary/random/lintPolicyFixture.ts",
			"../adapters/primary/web/lintPolicyFixture.ts",
		]
			.map((target) => `import '${target}';`)
			.join("\n"),
		shouldFail: false,
	});
});

test("primary adapters may call application but not secondary adapters", async () => {
	await check({
		filePath: paths.primary,
		code: "import '../../../application/lintPolicyFixture.ts';",
		shouldFail: false,
	});
	await check({
		filePath: paths.primary,
		code: "import '../../secondary/random/lintPolicyFixture.ts';",
		shouldFail: true,
	});
});

test("backend HTTP handlers call only the explicit same-service provider operations", async () => {
	await check({
		filePath: paths.apiHttp,
		code: "import '../../secondary/node/secret-crypto.ts';",
		shouldFail: false,
	});
	await check({
		filePath: paths.apiHttp,
		code: "import '../../secondary/node/secret-crypto-helper.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiOtherHttp,
		code: "import '../../secondary/node/secret-crypto.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiApplication,
		code: "import '../adapters/secondary/node/secret-crypto.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiDomain,
		code: "import '../adapters/secondary/node/secret-crypto.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiPorts,
		code: "import '../adapters/secondary/node/secret-crypto.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.apiHttp,
		code: "import '../../../../assistant/adapters/secondary/livekit/agent-dispatch-manager.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.assistantHttp,
		code: "import '../../secondary/livekit/agent-dispatch-manager.ts';",
		shouldFail: false,
	});
	await check({
		filePath: paths.assistantHttp,
		code: "import '../../secondary/livekit/agent-dispatch-helper.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.assistantApplication,
		code: "import '../adapters/secondary/livekit/agent-dispatch-manager.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.primary,
		code: "import '../../../../api/adapters/secondary/node/secret-crypto.ts';",
		shouldFail: true,
	});
});

test("secondary adapters use ports, never application or independent adapters", async () => {
	await check({
		filePath: paths.secondary,
		code: "import '../../../ports/lintPolicyFixture.ts';",
		shouldFail: false,
	});
	await check({
		filePath: paths.secondary,
		code: "import '../../../application/lintPolicyFixture.ts';",
		shouldFail: true,
	});
	await check({
		filePath: paths.secondary,
		code: "import '../../primary/web/lintPolicyFixture.ts';",
		shouldFail: true,
	});
	await check({ filePath: paths.secondary, code: "import '../fixed/lintPolicyFixture.ts';", shouldFail: true });
});

test("presentation imports composition, not concrete adapters", async () => {
	await check({
		filePath: paths.presentation,
		code: "import '../composition/lintPolicyFixture.ts';",
		shouldFail: false,
	});
	await check({
		filePath: paths.presentation,
		code: "import '../adapters/secondary/random/lintPolicyFixture.ts';",
		shouldFail: true,
	});
});

test("type imports, reexports, dynamic imports and require cannot bypass boundaries", async () => {
	const target = "../adapters/secondary/random/lintPolicyFixture.ts";
	await Promise.all(
		[
			`import type { Fixture } from '${target}';`,
			`export type { Fixture } from '${target}';`,
			`export * from '${target}';`,
			`const dependency = import('${target}');`,
			`type Dependency = import('${target}').Fixture;`,
			`const dependency = require('${target}');`,
			`import dependency = require('${target}');`,
		].map((code) => check({ filePath: paths.application, code, shouldFail: true })),
	);
});

test("core cannot import Node or framework libraries", async () => {
	await check({ filePath: paths.domain, code: "import 'node:fs';", shouldFail: true });
	await check({ filePath: paths.application, code: "import 'node:http';", shouldFail: true });
	await check({ filePath: paths.ports, code: "import 'typescript';", shouldFail: true });
	await check({ filePath: paths.secondary, code: "import 'node:crypto';", shouldFail: false });
});

test("unclassified source files are rejected", async () => {
	await check({
		filePath: paths.unknown,
		code: "export const value = 1;",
		shouldFail: true,
		rule: "boundaries/no-unknown-files",
	});
});

test("shared conventions are active in TypeScript", async () => {
	await Promise.all(
		[
			["let value = 1;", "no-restricted-syntax"],
			["export const won = true;", "policy/boolean-prefix"],
			["export const join = (left: string, right: string): string => left + right;", "policy/named-parameters"],
			["declare const values: number[]; if (values.length) {}", "policy/array-emptiness"],
			["const values: number[] = []; values.push(1);", "policy/immutable-arrays"],
			[
				"export const change = (value: { count: number }): void => { value.count = 1; };",
				"policy/parameter-mutation",
			],
			["export const value: any = 1;", "@typescript-eslint/no-explicit-any"],
			[
				"declare const value: unknown; export const name = value as string;",
				"@typescript-eslint/no-unsafe-type-assertion",
			],
			["JSON.parse('{}');", "policy/validated-input"],
			["throw new Error('Failure.');", "policy/named-messages"],
		].map(([code, rule]) => check({ filePath: paths.application, code, rule, shouldFail: true })),
	);
	await check({
		filePath: paths.application,
		code: "export const hasWon = true;",
		rule: "policy/boolean-prefix",
		shouldFail: false,
	});
});

test("CSS conventions, inline styles and dynamic custom properties are accepted", async () => {
	const examples = [
		'export const view = <div style={{ color: "red" }} />;\n',
		'declare const offset: number;\nexport const view = <div className="task-assignee-menu" style={{ top: offset, left: offset }} />;\n',
		"declare const styles: { readonly root: string };\nexport const view = <div className={styles.root} />;\n",
		'export const view = <div className="task-assignee-pill is-unassigned" />;\n',
		'export const view = <div className="mt-2 p-3 gap-3 block md:block" />;\n',
		[
			'import type { CSSProperties } from "react";',
			"",
			"declare const offset: number;",
			'type DynamicStyle = CSSProperties & { "--task-menu-top": string };',
			`const style: DynamicStyle = { "--task-menu-top": \`\${offset}px\` };`,
			'export const view = <div className="task-assignee-menu" style={style} />;',
			"",
		].join("\n"),
	];
	await Promise.all(
		[paths.presentation, paths.page].flatMap((filePath) =>
			examples.map(async (code) => {
				const [result] = await eslint.lintText(code, { filePath });
				assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
				assert.deepEqual(result.messages, [], JSON.stringify({ filePath, code, messages: result.messages }));
			}),
		),
	);
});

test("Tailwind rules and styling selectors are absent rather than disabled", async () => {
	await Promise.all(
		[paths.presentation, paths.page].map(async (filePath) => {
			const configuration = await eslint.calculateConfigForFile(filePath);
			assert.equal(Object.hasOwn(configuration.rules, "policy/static-tailwind"), false);
			assert.equal(Object.hasOwn(configuration.plugins.policy.rules, "static-tailwind"), false);
			const selectors = configuration.rules["no-restricted-syntax"].slice(1);
			assert.equal(
				selectors.some((entry) => /style|className/.test(typeof entry === "string" ? entry : entry.selector)),
				false,
			);
			assert.equal(configuration.rules["policy/used-react-props"][0], 2);
			assert.equal(configuration.rules["@typescript-eslint/no-explicit-any"][0], 2);
			assert.equal(configuration.rules["boundaries/dependencies"][0], 2);
		}),
	);
});

test("unrelated JSX restrictions and accessible native controls remain intact", async () => {
	await Promise.all(
		["export const view = <div>{true && <span />}</div>;"].map((code) =>
			check({ filePath: paths.presentation, code, rule: "no-restricted-syntax", shouldFail: true }),
		),
	);
	// Semantic layout and prose elements are allowed (matches main).
	await check({
		filePath: paths.presentation,
		code: "export const view = <section><h2>Title</h2><p>Body</p></section>;",
		rule: "no-restricted-syntax",
		shouldFail: false,
	});
	await check({
		filePath: paths.presentation,
		code: 'export const view = <button aria-label="Close" type="button">Close</button>;',
		rule: "no-restricted-syntax",
		shouldFail: false,
	});
});

test("adapter identity includes package and adapter, but permits its own files", async () => {
	await check({ filePath: paths.secondary, code: "import './another.ts';", shouldFail: false });
	await check({ filePath: paths.primary, code: "import './another.ts';", shouldFail: false });
	await check({ filePath: paths.primary, code: "import '../other/fixture.ts';", shouldFail: true });
	await check({
		filePath: paths.secondary,
		code: "import '../../../../api/adapters/secondary/random/fixture.ts';",
		shouldFail: true,
	});
});

test("workspace aliases retain the resolved role, including db concrete exports", async () => {
	await check({ filePath: paths.application, code: "import '@readymeet/db';", shouldFail: true });
	await check({
		filePath: paths.application,
		code: "import '@readymeet/db/adapters/secondary/postgres/fixture';",
		shouldFail: true,
	});
	await check({ filePath: paths.application, code: "import '@readymeet/shared/domain/fixture';", shouldFail: false });
	await check({ filePath: paths.domain, code: 'import "@readymeet/shared/ports/fixture";\n', shouldFail: true });
	await check({
		filePath: paths.application,
		code: "import '@/adapters/secondary/random/lintPolicyFixture';",
		shouldFail: true,
	});
	await check({ filePath: paths.composition, code: "import '@readymeet/db';", shouldFail: false });
});

test("framework wrappers keep primary and presentation dependency directions", async () => {
	await check({ filePath: paths.route, code: "import '@/application/lintPolicyFixture';", shouldFail: false });
	await check({
		filePath: paths.route,
		code: "import '@/adapters/secondary/random/lintPolicyFixture';",
		shouldFail: true,
	});
	await check({ filePath: paths.page, code: "import '@/composition/lintPolicyFixture';", shouldFail: false });
	await check({ filePath: paths.page, code: "import '@/application/lintPolicyFixture';", shouldFail: true });
	await check({
		filePath: paths.publicWrapper,
		code: "import '../../application/lintPolicyFixture.ts';",
		shouldFail: false,
	});
	await check({
		filePath: paths.addon,
		code: "import '../../secondary/apps-script/fixture.js';",
		shouldFail: true,
	});
});

test("test and tooling classification precedes the containing layer", async () => {
	await check({
		filePath: paths.colocatedTest,
		code: "import '../adapters/secondary/random/lintPolicyFixture.ts';",
		shouldFail: false,
	});
	await check({ filePath: paths.colocatedTest, code: "import 'node:fs';", shouldFail: false });
	await check({ filePath: paths.tooling, code: "import '@readymeet/db';", shouldFail: false });
});

test("path-sensitive rules inspect migrated presentation, framework TSX and all package inward roles", async () => {
	await Promise.all(
		[paths.presentation, paths.page].map((filePath) =>
			check({
				filePath,
				code: "type Props = { label: string; unused: string }; export function View({ label }: Props) { return <div>{label}</div>; }",
				rule: "policy/used-react-props",
				shouldFail: true,
			}),
		),
	);
	await Promise.all(
		[paths.domain, paths.ports, paths.sharedDomain, paths.sharedPorts].map((filePath) =>
			check({
				filePath,
				code: "export type RecordValue = {\n/** @nullable */\nvalue?: string;\n};",
				rule: "policy/optional-nullable",
				shouldFail: true,
			}),
		),
	);
	await check({
		filePath: paths.domain,
		code: "export type RecordValue = {\n/** @nullable */\nvalue?: string | null;\n};",
		rule: "policy/optional-nullable",
		shouldFail: false,
	});
});

test("authored add-on JavaScript is checked, including typed custom conventions", async () => {
	await check({
		filePath: paths.addonDomain,
		code: "import '../../adapters/secondary/apps-script/fixture.js';",
		shouldFail: true,
	});
	await Promise.all(
		[
			["let value = 1;", "no-restricted-syntax"],
			["export const won = true;", "policy/boolean-prefix"],
			["export function join(left, right) { return left + right; }", "policy/named-parameters"],
			["JSON.parse('{}');", "policy/validated-input"],
			["console.error('Failure');", "policy/comment-and-log"],
			["if (true) console.error('Failure.');", "curly"],
		].map(([code, rule]) => check({ filePath: paths.addon, code, rule, shouldFail: true })),
	);
});

test("core syntax and Codely rules remain errors", async () => {
	await Promise.all(
		[
			["for (const value of [1]) { console.error(value); }", "no-restricted-syntax"],
			["try {} catch {}", "no-restricted-syntax"],
			["Promise.resolve(1).then(console.error);", "no-restricted-syntax"],
			["declare const name: string; import(name);", "no-restricted-syntax"],
			["const unused = 1;", "@typescript-eslint/no-unused-vars"],
			["export const value = Math.abs(42);", "@typescript-eslint/no-magic-numbers"],
			["if (true) console.error('Done.');", "curly"],
			["export const value = 'format';", "prettier/prettier"],
		].map(([code, rule]) => check({ filePath: paths.application, code, rule, shouldFail: true })),
	);
});

test("native mutator lookup does not inspect inherited object keys", async () => {
	await check({
		filePath: paths.application,
		code: "class constructor { run(): void {} } const value = new constructor(); value.run();",
		rule: "policy/parameter-mutation",
		shouldFail: false,
	});
	await check({
		filePath: paths.application,
		code: "export function change(value: Map<string, number>): void { value.set('key', 1); }",
		rule: "policy/parameter-mutation",
		shouldFail: true,
	});
});

test("Next route wrappers share only their package's next-http adapter", async () => {
	await check({ filePath: paths.route, code: "import '@/adapters/primary/next-http/fixture';", shouldFail: false });
	await check({
		filePath: paths.route,
		code: "import '../../../../api/adapters/primary/next-http/fixture.ts';",
		shouldFail: true,
	});
});

test("platform globals are explicit and do not disable undefined-name checking", async () => {
	await check({ filePath: paths.addon, code: "ScriptApp.getOAuthToken();", rule: "no-undef", shouldFail: false });
	await check({ filePath: paths.publicWrapper, code: "Office.onReady();", rule: "no-undef", shouldFail: false });
	await check({ filePath: paths.addon, code: "MissingPlatform.doWork();", rule: "no-undef", shouldFail: true });
});

test("unknown local dependencies are not a permitted escape hatch", async () => {
	await check({
		filePath: paths.application,
		code: "import '../unclassified/lintPolicyFixture.ts';",
		rule: "boundaries/no-unknown-dependencies",
		shouldFail: true,
	});
});

test("calculated configurations have no warning-level rules", async () => {
	await Promise.all(
		[paths.application, paths.presentation, paths.addon, paths.tooling].map(async (filePath) => {
			const configuration = await eslint.calculateConfigForFile(filePath);
			const warningRules = Object.entries(configuration.rules).filter(([, value]) =>
				Array.isArray(value) ? value[0] === 1 || value[0] === "warn" : value === 1 || value === "warn",
			);
			assert.deepEqual(warningRules, []);
		}),
	);
});

test("product code cannot use colocated tests as a dependency escape hatch", async () => {
	await check({ filePath: paths.domain, code: "import './fixture.test.ts';", shouldFail: true });
	await check({ filePath: paths.application, code: "import '../domain/fixture.test.ts';", shouldFail: true });
});

test("every implementation role enforces the approved local dependency table", async () => {
	const allowed = {
		domain: ["domain"],
		ports: ["domain", "ports"],
		application: ["domain", "ports", "application"],
		primary: ["domain", "ports", "application", "primary", "composition"],
		secondary: ["domain", "ports", "secondary"],
		composition: ["domain", "ports", "application", "primary", "secondary", "composition"],
		presentation: ["domain", "presentation", "composition"],
	};
	await Promise.all(
		Object.entries(allowed).flatMap(([from, targets]) =>
			Object.keys(allowed).map((to) => {
				const target = relative(dirname(paths[from]), paths[to]);

				return check({
					filePath: paths[from],
					code: `import './${target}';`,
					shouldFail: !targets.includes(to),
				});
			}),
		),
	);
});

test("test/tooling precedence applies both inside adapters and framework entrypoints", async () => {
	await check({ filePath: paths.domain, code: "import './fixture.config.ts';", shouldFail: true });
	await check({ filePath: paths.colocatedTooling, code: "import '@readymeet/db';", shouldFail: false });
	await check({ filePath: paths.colocatedPageTest, code: "import '@readymeet/db';", shouldFail: false });
	await check({ filePath: paths.secondaryTest, code: "import '@readymeet/db';", shouldFail: false });
	await check({ filePath: paths.secondary, code: "import './fixture.test.ts';", shouldFail: true });
	await check({ filePath: paths.page, code: "import './page.test.tsx';", shouldFail: true });
});

test("primary adapters with matching names in other packages remain isolated", async () => {
	await check({
		filePath: paths.primary,
		code: "import '../../../../api/adapters/primary/web/fixture.ts';",
		shouldFail: true,
	});
});

test("installed libraries follow explicit role allowlists, not package-wide freedom", async () => {
	await check({ filePath: paths.domain, code: "import 'zod';", shouldFail: false });
	await check({ filePath: paths.presentation, code: "import 'react';", shouldFail: false });
	await check({ filePath: paths.domain, code: "import 'react';", shouldFail: true });
	await check({ filePath: paths.application, code: "import 'next/server';", shouldFail: true });
	await check({ filePath: paths.dbAdapter, code: "import 'pg';", shouldFail: false });
	await check({ filePath: paths.sharedDomain, code: "import 'tldts';", shouldFail: false });
});

test("MTS and CTS retain the Codely and custom TypeScript rules", async () => {
	await Promise.all(
		[paths.moduleDomain, paths.commonDomain].flatMap((filePath) =>
			[
				["Promise.resolve(1);", "@typescript-eslint/no-floating-promises"],
				["export const won = true;", "policy/boolean-prefix"],
				["export function value() { return 1; }", "@typescript-eslint/explicit-module-boundary-types"],
			].map(([code, rule]) => check({ filePath, code, rule, shouldFail: true })),
		),
	);
});

test("Next externally dictated signatures and names keep the reference exceptions", async () => {
	await check({
		filePath: paths.route,
		code: "export function GET(request: Request, context: { params: object }): Response { return new Response(request.url); }",
		rule: "policy/named-parameters",
		shouldFail: false,
	});
	await check({
		filePath: paths.page,
		code: "export const dynamicParams = false;",
		rule: "policy/boolean-prefix",
		shouldFail: false,
	});
	await check({
		filePath: paths.domain,
		code: "export const dynamicParams = false;",
		rule: "policy/boolean-prefix",
		shouldFail: true,
	});
});

test("nullable annotations apply to service-owned ports as well as package and app roles", async () => {
	await Promise.all(
		[paths.apiPorts, paths.assistantPorts].map((filePath) =>
			check({
				filePath,
				code: "export type Value = {\n/** @nullable */\nvalue?: string;\n};",
				rule: "policy/optional-nullable",
				shouldFail: true,
			}),
		),
	);
});

test("generated output cannot bypass dependencies from inside an otherwise valid layer", async () => {
	assert.equal(await eslint.isPathIgnored(join(fixtureRoot, paths.ignoredDomain)), true);
	await check({
		filePath: paths.domain,
		code: "import './dist/fixture.ts';",
		rule: "boundaries/no-ignored-dependencies",
		shouldFail: true,
	});
});

test("JSON parsing requires concrete validation rather than an unknown schema", async () => {
	await check({
		filePath: paths.domain,
		code: "import { z } from 'zod'; const schema = z.object({ name: z.string() }); schema.parse(JSON.parse('{}'));",
		rule: "policy/validated-input",
		shouldFail: false,
	});
	await check({
		filePath: paths.domain,
		code: "import { z } from 'zod'; z.unknown().parse(JSON.parse('{}'));",
		rule: "policy/validated-input",
		shouldFail: true,
	});
});

test("annotated externally dictated wire booleans retain their public spelling", async () => {
	await check({
		filePath: paths.domain,
		code: "export type Wire = {\n/** @external existing wire contract */\nenabled: boolean;\n};",
		rule: "policy/boolean-prefix",
		shouldFail: false,
	});
	await check({
		filePath: paths.domain,
		code: "export type Internal = { enabled: boolean };",
		rule: "policy/boolean-prefix",
		shouldFail: true,
	});
});

test("exact DB migrate and seed paths are composition delegates", async () => {
	await Promise.all(
		[paths.dbMigrate, paths.dbSeed].map(async (filePath) => {
			const [result] = await eslint.lintText('export type { Fixture } from "./composition/fixture.ts";\n', {
				filePath,
			});
			assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
			assert.deepEqual(result.messages, [], JSON.stringify({ filePath, messages: result.messages }));
			await check({
				filePath,
				code: "import './adapters/secondary/postgres/fixture.ts';",
				shouldFail: false,
			});
			await check({
				filePath,
				code: "import '../web/presentation/lintPolicyFixture.tsx';",
				shouldFail: true,
			});
		}),
	);
});

test("neighboring DB source does not inherit the operational entrypoint classification", async () => {
	await Promise.all(
		[paths.dbMigrateNeighbor, paths.dbSeedNeighbor].map((filePath) =>
			check({
				filePath,
				code: "export const value = 1;\n",
				rule: "boundaries/no-unknown-files",
				shouldFail: true,
			}),
		),
	);
});

test("DB CLI composition classification keeps SDK and inward-caller restrictions", async () => {
	await Promise.all(
		[paths.dbMigrate, paths.dbSeed].flatMap((filePath) =>
			["pg", "@prisma/client", "node:crypto"].map((dependency) =>
				check({ filePath, code: `import '${dependency}';`, shouldFail: true }),
			),
		),
	);
	await Promise.all(
		["migrate", "seed"].map((entrypoint) =>
			check({
				filePath: paths.application,
				code: `import '@readymeet/db/${entrypoint}';`,
				shouldFail: true,
			}),
		),
	);
});

test("the assistant OpenAI adapter may import the shared responses adapter", async () => {
	await check({
		filePath: paths.assistantOpenAI,
		code: "import '@readymeet/openai-responses';",
		shouldFail: false,
	});
	await check({
		filePath: paths.apiComposition,
		code: "import '@readymeet/openai-responses';",
		shouldFail: false,
	});
	await Promise.all(
		[paths.secondary, paths.assistantApplication, paths.assistantLogger].map((filePath) =>
			check({ filePath, code: "import '@readymeet/openai-responses';", shouldFail: true }),
		),
	);
});

test("only the exact assistant composition bootstrap may import the OpenAI web shim", async () => {
	const [result] = await eslint.lintText('import "openai/shims/web";\n', { filePath: paths.assistantEntry });
	assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
	assert.deepEqual(result.messages, [], JSON.stringify(result.messages));
	await check({
		filePath: paths.assistantEntry,
		code: "export type { Fixture } from './composition/fixture.ts';",
		shouldFail: false,
	});
	await Promise.all(
		[paths.assistantComposition, paths.assistantOtherComposition].map((filePath) =>
			check({ filePath, code: "import 'openai/shims/web';", shouldFail: true }),
		),
	);
	await check({
		filePath: paths.assistantNeighbor,
		code: "export const value = 1;",
		rule: "boundaries/no-unknown-files",
		shouldFail: true,
	});
	await Promise.all(
		[paths.assistantEntry, paths.assistantComposition].flatMap((filePath) =>
			["openai", "openai/shims/node"].map((dependency) =>
				check({ filePath, code: `import '${dependency}';`, shouldFail: true }),
			),
		),
	);
});

test("ReadyAddon is readonly and confined to the exact Apps Script deployment wrapper", async () => {
	await check({ filePath: paths.addon, code: "ReadyAddon.onHomepage();", rule: "no-undef", shouldFail: false });
	await check({ filePath: paths.addon, code: "ReadyAddon = {};", rule: "no-global-assign", shouldFail: true });
	await Promise.all(
		[paths.addonNeighbor, paths.addonDomain, paths.addonSecondary, paths.publicWrapper].map((filePath) =>
			check({ filePath, code: "ReadyAddon.onHomepage();", rule: "no-undef", shouldFail: true }),
		),
	);
	await check({ filePath: paths.addon, code: "OtherAddon.onHomepage();", rule: "no-undef", shouldFail: true });
});

test("exact Next auth and middleware facades retain their composition and primary roles", async () => {
	await check({
		filePath: paths.webAuth,
		code: "export type { Fixture } from './composition/lintPolicyFixture.ts';",
		shouldFail: false,
	});
	await check({ filePath: paths.webAuth, code: "import './presentation/lintPolicyFixture.tsx';", shouldFail: true });
	await check({ filePath: paths.application, code: "import '@/auth';", shouldFail: true });
	await check({
		filePath: paths.webMiddleware,
		code: "export type { Fixture } from './adapters/primary/next-http/fixture.ts';",
		shouldFail: false,
	});
	await Promise.all(
		[
			"./adapters/primary/other/fixture.ts",
			"./adapters/secondary/random/lintPolicyFixture.ts",
			"../api/adapters/primary/next-http/fixture.ts",
		].map((dependency) =>
			check({ filePath: paths.webMiddleware, code: `import '${dependency}';`, shouldFail: true }),
		),
	);
	await Promise.all(
		[paths.webAuthNeighbor, paths.webMiddlewareNeighbor].map((filePath) =>
			check({ filePath, code: "export const value = 1;", rule: "boundaries/no-unknown-files", shouldFail: true }),
		),
	);
});

test("Apps Script exported handlers are accepted only in the exact script wrapper", async () => {
	const handlers = [
		"onHomepage",
		"onCreateReadyConference",
		"handleRetryReadyConnection",
		"debugIdentityAudience",
		"debugVerify",
	];
	const code = [
		`/* exported ${handlers.join(", ")} */`,
		...handlers.flatMap((handler) => [`function ${handler}() {`, `\treturn ReadyAddon.${handler}();`, "}", ""]),
	].join("\n");
	const [result] = await eslint.lintText(code, { filePath: paths.addon });
	assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
	assert.deepEqual(result.messages, [], JSON.stringify(result.messages));
	const wrapperConfiguration = await eslint.calculateConfigForFile(paths.addon);
	assert.equal(wrapperConfiguration.languageOptions.sourceType, "script");
	assert.equal(wrapperConfiguration.rules["unused-imports/no-unused-vars"][0], 2);
	await check({
		filePath: paths.addon,
		code: "const unusedLocal = 1;",
		rule: "unused-imports/no-unused-vars",
		shouldFail: true,
	});
	await Promise.all(
		[paths.addonNeighbor, paths.addonDomain, paths.addonSecondary].map(async (filePath) => {
			const configuration = await eslint.calculateConfigForFile(filePath);
			assert.equal(configuration.languageOptions.sourceType, "module");
			await check({ filePath, code: "export const value = 1;", rule: "no-restricted-syntax", shouldFail: false });
		}),
	);
});

test("installed Next HTTP subpaths are permitted only for web next-http origins", async () => {
	await Promise.all(
		[
			paths.nextPrimary,
			paths.nextAuthCallbacks,
			paths.nextOAuthMiddleware,
			paths.route,
			paths.webMiddleware,
		].flatMap((filePath) =>
			["next/headers", "next/server"].map((dependency) =>
				check({ filePath, code: `import '${dependency}';`, shouldFail: false }),
			),
		),
	);
	await Promise.all(
		[paths.domain, paths.application, paths.primary, paths.otherPrimary].flatMap((filePath) =>
			["next/headers", "next/server"].map((dependency) =>
				check({ filePath, code: `import '${dependency}';`, shouldFail: true }),
			),
		),
	);
	await Promise.all(
		[
			paths.nextPrimary,
			paths.nextAuthCallbacks,
			paths.nextOAuthMiddleware,
			paths.route,
			paths.webMiddleware,
		].flatMap((filePath) =>
			["next", "next/navigation"].map((dependency) =>
				check({ filePath, code: `import '${dependency}';`, shouldFail: true }),
			),
		),
	);
});

test("exact API index and memory worker entrypoints are thin composition delegates", async () => {
	await Promise.all(
		[paths.apiIndex, paths.apiMemoryEntry].map(async (filePath) => {
			const [result] = await eslint.lintText('export type { Fixture } from "./composition/fixture.ts";\n', {
				filePath,
			});
			assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
			assert.deepEqual(result.messages, [], JSON.stringify({ filePath, messages: result.messages }));
			await check({
				filePath,
				code: "import '../web/presentation/lintPolicyFixture.tsx';",
				shouldFail: true,
			});
			await check({ filePath, code: "import 'node:crypto';", shouldFail: true });
		}),
	);
});

test("neighboring API source stays unknown and inward roles cannot import API entrypoints", async () => {
	await Promise.all(
		[paths.apiIndexNeighbor, paths.apiMemoryNeighbor].map((filePath) =>
			check({ filePath, code: "export const value = 1;", rule: "boundaries/no-unknown-files", shouldFail: true }),
		),
	);
	await Promise.all(
		[paths.apiDomain, paths.apiPorts, paths.apiApplication].flatMap((filePath) =>
			["../index.ts", "../memory-worker-entry.ts"].map((dependency) =>
				check({ filePath, code: `import '${dependency}';`, shouldFail: true }),
			),
		),
	);
});

test("verified static response builders construct output without input validation", async () => {
	await Promise.all(
		[
			'import { NextResponse } from "next/server"; NextResponse.json({ value: 1 }, { status: 200 });',
			'import { NextResponse as Reply } from "next/server"; Reply.json({ value: 1 });',
			"Response.json({ value: 1 });",
			"Response.json({ value: 1 }, { status: 200 });",
		].map((code) => check({ filePath: paths.route, code, rule: "policy/validated-input", shouldFail: false })),
	);
	await Promise.all(
		[
			'import type { NextRequest } from "next/server"; declare const request: NextRequest; request.json();',
			'import type { NextResponse } from "next/server"; declare const response: NextResponse; response.json();',
			"declare const response: Response; response.json();",
			"class NextResponse { static json(value: unknown): unknown { return value; } } NextResponse.json({ value: 1 });",
			"class Request { json(): unknown { return {}; } } new Request().json();",
			'import { NextResponse } from "next/server"; NextResponse.json(JSON.parse("{}"));',
			'import { NextResponse } from "next/server"; const Reply = NextResponse; Reply.json({ value: 1 });',
			'import { NextResponse } from "next/server"; NextResponse.json();',
			'import { NextResponse } from "next/server"; NextResponse.json({}, {}, {});',
			'const Unrelated = { json(value: unknown): unknown { return value; } }; Unrelated.json(JSON.parse("{}"));',
		].map((code) => check({ filePath: paths.route, code, rule: "policy/validated-input", shouldFail: true })),
	);
});

test("named route signatures require exact exported HTTP routes and installed framework request declarations", async () => {
	await Promise.all(
		[paths.route, paths.nextAdapterRoute].flatMap((filePath) =>
			[
				'import type { NextRequest } from "next/server"; export function GET(request: NextRequest, context: { params: object }): Response { return new Response(request.url); }',
				'import type { NextRequest as Incoming } from "next/server"; export const POST = (request: Incoming, context: { params: object }): Response => new Response(request.url);',
			].map((code) => check({ filePath, code, rule: "policy/named-parameters", shouldFail: false })),
		),
	);
	await Promise.all(
		[
			[
				paths.routeNeighbor,
				'import type { NextRequest } from "next/server"; export function GET(request: NextRequest, context: object): Response { return new Response(request.url); }',
			],
			[
				paths.nextPrimary,
				'import type { NextRequest } from "next/server"; export function GET(request: NextRequest, context: object): Response { return new Response(request.url); }',
			],
			[
				paths.route,
				'import type { NextRequest } from "next/server"; export function handle(request: NextRequest, context: object): Response { return new Response(request.url); }',
			],
			[
				paths.route,
				'import type { NextRequest } from "next/server"; function GET(request: NextRequest, context: object): Response { return new Response(request.url); }',
			],
			[
				paths.route,
				'import type { NextRequest } from "next/server"; export const handler = { GET(request: NextRequest, context: object): Response { return new Response(request.url); } };',
			],
			[
				paths.route,
				'class NextRequest { url = ""; } export function GET(request: NextRequest, context: object): Response { return new Response(request.url); }',
			],
			[
				paths.route,
				"interface Request { url: string } export function POST(request: Request, context: object): Response { return new Response(request.url); }",
			],
		].map(([filePath, code]) => check({ filePath, code, rule: "policy/named-parameters", shouldFail: true })),
	);
});

test("native Response builder permission cannot bypass instance, shadowed or nested input validation", async () => {
	await Promise.all(
		[
			"Response.json({ value: 1 }, { status: 201 });",
			'import { z } from "zod"; Response.json(z.object({ value: z.number() }).parse(JSON.parse("{}")));',
		].map((code) =>
			check({ filePath: paths.nextPrimary, code, rule: "policy/validated-input", shouldFail: false }),
		),
	);
	await Promise.all(
		[
			"declare const response: Response; response.json();",
			"class Response { static json(value: unknown): unknown { return value; } } Response.json({ value: 1 });",
			"const Response = { json(value: unknown): unknown { return value; } }; Response.json({ value: 1 });",
			"function parse(Response: Response): void { Response.json(); }",
			'Response.json(JSON.parse("{}"));',
			"declare const request: Request; Response.json(await request.json());",
			"Response.json();",
			"Response.json({}, {}, {});",
		].map((code) => check({ filePath: paths.nextPrimary, code, rule: "policy/validated-input", shouldFail: true })),
	);
});

test("backend consumers may import only their used Node primitives directly", async () => {
	await Promise.all(
		["node:crypto", "node:dns/promises", "node:fs/promises", "node:net", "node:os", "node:path"].map((dependency) =>
			check({ filePath: paths.apiApplication, code: `import '${dependency}';`, shouldFail: false }),
		),
	);
	await Promise.all(
		[paths.assistantApplication, paths.apiHttp].map((filePath) =>
			check({ filePath, code: 'import "node:crypto";', shouldFail: false }),
		),
	);
	await Promise.all(
		["node:path", "node:url"].map((dependency) =>
			check({ filePath: paths.apiConfigure, code: `import '${dependency}';`, shouldFail: false }),
		),
	);
	await check({
		filePath: paths.apiApplication,
		code: 'export { createHash } from "node:crypto";',
		shouldFail: false,
	});
});

test("direct Node permissions do not leak into browser, domain, ports or other backend roles", async () => {
	await Promise.all(
		[
			paths.application,
			paths.domain,
			paths.ports,
			paths.primary,
			paths.composition,
			paths.presentation,
			paths.apiDomain,
			paths.apiPorts,
			paths.apiComposition,
			paths.apiConfigure,
			paths.assistantDomain,
			paths.assistantPorts,
			paths.assistantComposition,
			paths.assistantHttp,
			paths.crossPrimary,
		].map((filePath) => check({ filePath, code: 'import "node:crypto";', shouldFail: true })),
	);
	await Promise.all(
		[paths.assistantApplication, paths.apiHttp, paths.apiComposition, paths.assistantComposition].flatMap(
			(filePath) =>
				["node:dns/promises", "node:fs/promises", "node:net", "node:os", "node:path", "node:url"].map(
					(dependency) => check({ filePath, code: `import '${dependency}';`, shouldFail: true }),
				),
		),
	);
});

test("backend Node permissions keep unrelated built-ins and provider SDKs forbidden", async () => {
	await Promise.all(
		[paths.apiApplication, paths.assistantApplication, paths.apiHttp, paths.apiConfigure].flatMap((filePath) =>
			[
				"node:child_process",
				"node:fs",
				"node:dns",
				"crypto",
				"fs/promises",
				"dns/promises",
				"undici",
				"livekit-server-sdk",
			].map((dependency) => check({ filePath, code: `import '${dependency}';`, shouldFail: true })),
		),
	);
	await check({ filePath: paths.apiApplication, code: 'import "stripe";', shouldFail: true });
	await check({ filePath: paths.assistantApplication, code: 'import "openai";', shouldFail: true });
	await check({ filePath: paths.apiApplication, code: 'import "node:url";', shouldFail: true });
	await check({ filePath: paths.apiApplication, code: 'import("node:child_process");', shouldFail: true });
});

test("only the API memory-process child adapter and the database migrator may import node:child_process", async () => {
	await check({ filePath: paths.apiChildProcess, code: 'import "node:child_process";', shouldFail: false });
	await check({ filePath: paths.dbMigrations, code: 'import "node:child_process";', shouldFail: false });
	await check({
		filePath: paths.apiChildProcess,
		code: 'export { fork } from "node:child_process";',
		shouldFail: false,
	});
	await Promise.all(
		[
			paths.apiChildProcessNeighbor,
			paths.apiOtherChildProcess,
			paths.assistantChildProcess,
			paths.crossPrimary,
			paths.apiApplication,
			paths.apiDomain,
			paths.apiPorts,
			paths.apiComposition,
			paths.apiIndex,
		].map((filePath) => check({ filePath, code: 'import "node:child_process";', shouldFail: true })),
	);
	await check({ filePath: paths.apiChildProcess, code: 'import "child_process";', shouldFail: true });
});

test("react-query is allowed only in the exact web browser-query-cache secondary adapter", async () => {
	await Promise.all(
		[paths.browserQueryCache, paths.nestedBrowserQueryCache].map((filePath) =>
			check({ filePath, code: 'import "@tanstack/react-query";', shouldFail: false }),
		),
	);
	await Promise.all(
		[
			paths.domain,
			paths.application,
			paths.ports,
			paths.secondary,
			paths.otherSecondary,
			paths.browserQueryCacheNeighbor,
			paths.otherPackageBrowserQueryCache,
			paths.primary,
		].map((filePath) => check({ filePath, code: 'import "@tanstack/react-query";', shouldFail: true })),
	);
});

test("persistence simplicity is guidance, not a blanket SQL or transaction ban", async () => {
	const config = await eslint.calculateConfigForFile(paths.dbAdapter);
	assert.equal(Object.hasOwn(config.rules, "policy/no-raw-sql"), false);
	assert.equal(Object.hasOwn(config.plugins.policy.rules, "no-raw-sql"), false);
	await Promise.all(
		[
			"await db.transaction(async () => undefined);",
			'await pool.query("SELECT id FROM meetings WHERE id = $1", [meetingId]);',
			'await client.query("SELECT id FROM meetings WHERE id = $1", [meetingId]);',
			"await db.execute(sql`SELECT 1`);",
			"const value = sql`COALESCE(started_at, now())`;",
		].map((code) => check({ filePath: paths.dbAdapter, code, rule: "policy/no-raw-sql", shouldFail: false })),
	);
});

test("only the exact assistant observability logger may import node:console", async () => {
	await check({ filePath: paths.assistantLogger, code: 'import "node:console";', shouldFail: false });
	await Promise.all(
		[
			paths.assistantLoggerNeighbor,
			paths.assistantOtherLogger,
			paths.assistantApplication,
			paths.assistantDomain,
			paths.assistantPorts,
			paths.assistantComposition,
			paths.assistantEntry,
			paths.apiLogger,
		].map((filePath) => check({ filePath, code: 'import "node:console";', shouldFail: true })),
	);
	await check({ filePath: paths.assistantLogger, code: 'import "console";', shouldFail: true });
});

test("native Console methods work without weakening global no-console or log message rules", async () => {
	const code = [
		'import { Console } from "node:console";',
		"",
		"const logger = new Console({ stdout: process.stdout, stderr: process.stderr });",
		'logger.log("Ready.");',
		'logger.error("Failure.");',
		"",
	].join("\n");
	const [result] = await eslint.lintText(code, { filePath: paths.assistantLogger });
	assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
	assert.deepEqual(result.messages, [], JSON.stringify(result.messages));
	await check({
		filePath: paths.assistantLogger,
		code: 'console.log("Ready.");',
		rule: "no-console",
		shouldFail: true,
	});
	await check({
		filePath: paths.assistantLogger,
		code: code.replace('logger.log("Ready.")', 'logger.log("Ready")'),
		rule: "policy/comment-and-log",
		shouldFail: true,
	});
});
