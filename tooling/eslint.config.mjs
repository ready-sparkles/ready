import eslintConfigCodely from "eslint-config-codely";
import boundaries from "eslint-plugin-boundaries";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

import { dependencyPolicies, elements, files } from "./architecture.mjs";

const jiti = createJiti(import.meta.url);
const { codeRules, frontendRules, strictLintConfiguration } = await jiti.import("./eslint.rules.ts");
const { policyPlugin } = await jiti.import("./policyPlugin.ts");
const platformConfiguration = [
	{
		files: ["web/adapters/primary/google-calendar/Code.js"],
		languageOptions: { sourceType: "script", globals: { ReadyAddon: "readonly" } },
	},
	{
		files: [
			"web/adapters/primary/google-calendar/**/*.{js,ts}",
			"web/adapters/secondary/apps-script/**/*.ts",
			"web/composition/google-calendar/**/*.ts",
		],
		languageOptions: {
			globals: {
				ScriptApp: "readonly",
				PropertiesService: "readonly",
				UrlFetchApp: "readonly",
				CacheService: "readonly",
				ConferenceDataService: "readonly",
				CardService: "readonly",
				Utilities: "readonly",
			},
		},
	},
	{
		files: ["web/public/outlook/**/*.js", "web/adapters/primary/outlook/**/*.{js,mjs,ts}"],
		languageOptions: { globals: { Office: "readonly" } },
	},
];
const authoredSource = [
	"{web,api,assistant,db,shared,openai-responses,meeting-agent}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
];
const generatedOutputIgnores = [
	"web/next-env.d.ts",
	"**/.codegraph/**",
	"**/dist/**",
	"**/.next/**",
	"**/.next-*/**",
	"**/out/**",
	"**/coverage/**",
	"web/public/outlook/{core,commands,meeting-flow,taskpane,dialog,command-error}.js",
	"**/.venv/**",
	"**/__pycache__/**",
	"**/.pytest_cache/**",
];

const mapCodelyConfiguration = (configuration) => ({
	...configuration,
	...(configuration.files === undefined
		? {}
		: {
				files: configuration.files.map((pattern) => (pattern === "**/*.ts" ? "**/*.{ts,mts,cts}" : pattern)),
			}),
});

const createBoundaryConfiguration = (rootPath) => ({
	files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
	plugins: { boundaries },
	settings: {
		"boundaries/root-path": rootPath,
		"boundaries/elements": elements,
		"boundaries/files": files,
		"boundaries/ignore": generatedOutputIgnores,

		"boundaries/dependency-nodes": ["import", "export", "require", "dynamic-import"],
		"boundaries/additional-dependency-nodes": [
			{ selector: "TSImportType > Literal", kind: "type", name: "type-import" },
			{ selector: "TSExternalModuleReference > Literal", kind: "value", name: "import-equals" },
		],
		"import-x/resolver": { typescript: { project: `${rootPath}/tsconfig.eslint.json` } },
		"import/resolver": { typescript: { project: `${rootPath}/tsconfig.eslint.json` } },
	},
	rules: {
		"boundaries/no-unknown-files": "error",
		"boundaries/no-unknown-dependencies": "error",
		"boundaries/no-ignored-dependencies": "error",
		"boundaries/dependencies": [
			"error",
			{
				default: "disallow",
				checkAllOrigins: true,
				checkInternals: true,
				checkUnknownLocals: true,
				policies: dependencyPolicies,
			},
		],
	},
});

export const createLintConfiguration = (rootPath) => [
	...eslintConfigCodely.full
		.filter((configuration) => configuration.ignores === undefined)
		.map(mapCodelyConfiguration),
	...platformConfiguration,
	{
		ignores: [
			"**/node_modules/**",
			"**/fixtures/react-doctor-replacement/**",
			"db/generated/**",
			...generatedOutputIgnores,
		],
	},
	{
		rules: {
			...codeRules,
			"unused-imports/no-unused-vars": "error",
			"check-file/folder-naming-convention": ["error", { "**/*": "+([a-zA-Z0-9-\\[\\]\\(\\)\\.])" }],
		},
	},
	...strictLintConfiguration.map((configuration) => ({
		...configuration,
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				...configuration.languageOptions.parserOptions,
				project: [`${rootPath}/tsconfig.eslint.json`],
				tsconfigRootDir: rootPath,
			},
		},
	})),
	{
		files: ["**/*.{js,jsx,mjs,cjs}"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: false,
				project: [`${rootPath}/tsconfig.eslint.json`],
				tsconfigRootDir: rootPath,
			},
		},
	},
	{ plugins: { policy: policyPlugin }, rules: { "policy/comment-and-log": "error" } },
	{
		files: ["**/*.{ts,tsx,mts,cts}", ...authoredSource],
		rules: {
			"policy/boolean-prefix": "error",
			"policy/named-parameters": "error",
			"policy/array-emptiness": "error",
			"policy/immutable-arrays": "error",
			"policy/parameter-mutation": "error",
			"no-param-reassign": ["error", { props: false }],
		},
	},
	{
		files: authoredSource,
		rules: {
			"policy/named-messages": "error",
			"policy/validated-input": "error",
			"@typescript-eslint/no-magic-numbers": [
				"error",
				{
					ignore: [-1, 0, 1],
					ignoreArrayIndexes: true,
					ignoreEnums: true,
					ignoreNumericLiteralTypes: true,
					ignoreTypeIndexes: true,
					ignoreReadonlyClassProperties: true,
					enforceConst: true,
					detectObjects: true,
				},
			],
		},
	},
	{
		// Plain scripts under web/public/outlook are served to Outlook and cannot import Zod.
		// The esbuild bundles in this directory are ignored above and are not linted as source.
		files: ["web/public/outlook/**/*.js"],
		rules: { "policy/validated-input": "off" },
	},
	{
		files: ["{web,api,assistant,db,shared,openai-responses}/{domain,ports}/**/*.{ts,tsx,mts,cts}"],
		rules: { "policy/optional-nullable": "error" },
	},
	{
		files: ["**/*.{tsx,jsx}"],
		rules: frontendRules,
	},
	{
		files: ["{web,api,assistant,db,shared,openai-responses}/presentation/**/*.tsx", "web/app/**/*.tsx"],
		rules: { "policy/used-react-props": "error" },
	},
	createBoundaryConfiguration(rootPath),
];

export default createLintConfiguration(fileURLToPath(new URL("../", import.meta.url)));
