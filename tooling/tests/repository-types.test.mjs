import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryTypesUrl = new URL("../../db/ports/repository.ts", import.meta.url);

test("repository type facade emits no runtime dependencies", async () => {
	const source = await readFile(repositoryTypesUrl, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
		fileName: fileURLToPath(repositoryTypesUrl),
	});
	assert.equal(outputText.trim(), "export {};");
});

test("repository type consumers load without initializing the database", () => {
	const consumers = [
		repositoryTypesUrl.href,
		new URL("../../api/ports/repository-runtime.ts", import.meta.url).href,
		new URL("../../assistant/ports/repository-runtime.ts", import.meta.url).href,
	];
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`await Promise.all(${JSON.stringify(consumers)}.map((consumer) => import(consumer)));`,
		],
		{
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			env: { ...process.env, DATABASE_URL: "invalid-database-url", DATABASE_POOL_MAX: "invalid-pool-size" },
			encoding: "utf8",
		},
	);
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
});
