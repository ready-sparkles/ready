import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

["meeting-agent/Dockerfile"].forEach((dockerfile) => {
	test(`${dockerfile} ends with a dedicated non-root runtime user`, async () => {
		const source = await readFile(new URL(`../../${dockerfile}`, import.meta.url), "utf8");
		const users = [...source.matchAll(/^USER\s+(.+)$/gm)];
		assert.equal(users.at(-1)?.[1].trim(), "app:app");
		assert.match(source, /useradd[^\n]*--create-home[^\n]*app/);
		assert.match(source, /HOME=\/home\/app/);
		assert.ok(source.lastIndexOf("USER app:app") > source.lastIndexOf("RUN "));
	});
});
