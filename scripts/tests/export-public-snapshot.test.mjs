import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exportPublicSnapshot, isPublicSnapshotPath } from "../export-public-snapshot.mjs";

const license = readFileSync(new URL("../../LICENSE", import.meta.url), "utf8");
const gitIdentity = {
	...process.env,
	GIT_AUTHOR_NAME: "Ready Snapshot Test",
	GIT_AUTHOR_EMAIL: "snapshot-test@example.com",
	GIT_COMMITTER_NAME: "Ready Snapshot Test",
	GIT_COMMITTER_EMAIL: "snapshot-test@example.com",
};

test("BUSL parameters name the licensors and grant no production use", () => {
	assert.match(license, /^Business Source License 1\.1\n/);
	assert.match(license, /Licensor:\s+Devin Ersoy and Sam Zetterberg\n/);
	assert.match(license, /The Licensed Work is \(c\) 2026 Devin Ersoy and Sam Zetterberg/);
	assert.match(license, /Additional Use Grant:\s+None\n/);
	assert.match(license, /Change Date:\s+2030-11-03\n/);
	assert.match(license, /Change License:\s+GPL Version 2\.0 or any later version\n/);
	assert.match(license, /4\. Not to modify this License in any other way\./);
});

test("public snapshot paths omit private planning and agent files", () => {
	assert.equal(isPublicSnapshotPath("LICENSE"), true);
	assert.equal(isPublicSnapshotPath("README.md"), true);
	assert.equal(isPublicSnapshotPath("scripts/export-public-snapshot.mjs"), true);
	assert.equal(isPublicSnapshotPath("web/app/about/page.tsx"), true);
	assert.equal(isPublicSnapshotPath("plans/about-page-story.md"), false);
	assert.equal(isPublicSnapshotPath(".agents/skills/safeguard/SKILL.md"), false);
	assert.equal(isPublicSnapshotPath(".claude/skills/safeguard"), false);
	assert.equal(isPublicSnapshotPath("AGENTS.md"), false);
	assert.equal(isPublicSnapshotPath("skills-lock.json"), false);
	assert.equal(isPublicSnapshotPath("web/AGENTS.md"), true);
});

function restoreEnv(previousEnv) {
	Object.entries(previousEnv).forEach(([key, value]) => {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	});
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, { cwd, env: gitIdentity, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);

	return result.stdout.trim();
}

function writeSourceFile(repoRoot, filePath, contents) {
	const target = join(repoRoot, filePath);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, contents);
}

test("export creates one commit and leaves private history behind", () => {
	const source = mkdtempSync(join(tmpdir(), "ready-source-"));
	const destination = join(tmpdir(), `ready-public-${process.pid}-${Date.now()}`);
	try {
		writeSourceFile(source, "LICENSE", "Business Source License 1.1\n");
		writeSourceFile(source, "README.md", "Ready\n");
		writeSourceFile(source, "web/app/about/page.tsx", "source-available\n");
		writeSourceFile(source, "plans/private.md", "private plan\n");
		writeSourceFile(source, "AGENTS.md", "agent instructions\n");
		writeSourceFile(source, "skills-lock.json", "{}\n");
		writeSourceFile(source, ".agents/skills/secret.md", "secret skill\n");
		writeSourceFile(source, ".claude/skills/secret.md", "secret skill\n");
		runGit(source, ["init", "-b", "main"]);
		runGit(source, ["add", "--all", "--force"]);
		runGit(source, ["commit", "--message", "first private"]);
		writeSourceFile(source, "plans/private.md", "private history note\n");
		runGit(source, ["add", "--all", "--force"]);
		runGit(source, ["commit", "--message", "private history note"]);
		assert.equal(runGit(source, ["rev-list", "--count", "HEAD"]), "2");
		writeSourceFile(source, "README.md", "DIRTY SECRET\n");
		writeSourceFile(source, "local-secret.txt", "do not publish\n");

		const previousEnv = {
			GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
			GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
			GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
			GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
		};
		Object.assign(process.env, gitIdentity);
		try {
			exportPublicSnapshot({ repoRoot: source, destination });
		} finally {
			restoreEnv(previousEnv);
		}

		assert.equal(readFileSync(join(destination, "LICENSE"), "utf8"), "Business Source License 1.1\n");
		assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "Ready\n");
		assert.equal(existsSync(join(destination, "local-secret.txt")), false);
		assert.equal(readFileSync(join(destination, "web/app/about/page.tsx"), "utf8"), "source-available\n");
		assert.equal(runGit(destination, ["rev-list", "--count", "HEAD"]), "1");
		assert.equal(
			runGit(destination, ["log", "-1", "--format=%s"]),
			"Publish the Ready source snapshot under BUSL-1.1.",
		);
		assert.equal(runGit(destination, ["remote"]), "");
		const exportedFiles = runGit(destination, ["ls-files"]).split("\n").filter(Boolean).sort();
		assert.deepEqual(exportedFiles, ["LICENSE", "README.md", "web/app/about/page.tsx"]);
		const history = runGit(destination, ["log", "--format=%B"]);
		assert.equal(history.includes("private history note"), false);
		assert.equal(history.includes("first private"), false);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(destination, { recursive: true, force: true });
	}
});

test("export refuses a snapshot inside the source repository or without LICENSE", () => {
	const source = mkdtempSync(join(tmpdir(), "ready-source-"));
	try {
		writeSourceFile(source, "README.md", "Ready\n");
		runGit(source, ["init", "-b", "main"]);
		runGit(source, ["add", "--all"]);
		runGit(source, ["commit", "--message", "readme only"]);
		const missingLicense = join(tmpdir(), `ready-missing-license-${process.pid}-${Date.now()}`);
		assert.throws(() => exportPublicSnapshot({ repoRoot: source, destination: missingLicense }), /without LICENSE/);
		assert.equal(existsSync(missingLicense), false);
		writeSourceFile(source, "LICENSE", "Business Source License 1.1\n");
		runGit(source, ["add", "--all"]);
		runGit(source, ["commit", "--message", "add license"]);
		assert.throws(
			() => exportPublicSnapshot({ repoRoot: source, destination: join(source, "nested") }),
			/outside the source repository/,
		);
	} finally {
		rmSync(source, { recursive: true, force: true });
	}
});
