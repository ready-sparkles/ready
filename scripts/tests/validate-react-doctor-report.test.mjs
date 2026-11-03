import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobIndent = /^( +)node:$/m.exec(workflow)?.[1];
if (!jobIndent) {
	throw new Error("ci.yml must declare a node job after the React Doctor gate");
}
const gateMatch = new RegExp(`^[ ]+run: \\|\n( +)set \\+e\n([\\s\\S]*?)(?=^${jobIndent}node:)`, "m").exec(workflow);
if (!gateMatch) {
	throw new Error("ci.yml React Doctor gate script must be parseable");
}
const gateIndent = gateMatch[1];
const gate = `${gateIndent}set +e\n${gateMatch[2]}`
	.split("\n")
	.map((line) => (line.startsWith(gateIndent) ? line.slice(gateIndent.length) : line))
	.join("\n")
	.replace(/\n+$/, "");

const validReport = {
	schemaVersion: 3,
	version: "0.9.17",
	mode: "baseline",
	ok: true,
	baseline: {
		source: "base",
		baseRef: "abc123",
		baseTotalCount: 0,
		fixedCount: 0,
		matchedCount: 0,
	},
	projects: [],
	diagnostics: [],
};

function runGate(t, report, cliStatus = 0) {
	const directory = mkdtempSync(join(tmpdir(), "react-doctor-gate-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "scripts"), { recursive: true });
	writeFileSync(
		join(directory, "scripts/validate-react-doctor-report.mjs"),
		readFileSync(new URL("../validate-react-doctor-report.mjs", import.meta.url)),
	);
	writeFileSync(join(directory, "pnpm"), '#!/bin/bash\nprintf "%s" "$REPORT"\nexit "$CLI_STATUS"\n', { mode: 0o755 });

	return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", gate], {
		cwd: directory,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${directory}:${process.env.PATH}`,
			BASE_SHA: "abc123",
			REPORT: typeof report === "string" ? report : JSON.stringify(report),
			CLI_STATUS: String(cliStatus),
		},
	});
}

test("successful empty source comparisons pass the workflow gate", (t) => {
	assert.equal(runGate(t, validReport).status, 0);
});

test("degraded or missing baseline comparisons fail even when the CLI exits zero", (t) => {
	[
		{ ...validReport, baselineDegraded: true },
		{ ...validReport, baseline: undefined },
		{ ...validReport, mode: "diff" },
		{ ...validReport, ok: false },
		{ ...validReport, version: "0.9.18" },
		{ ...validReport, baseline: { source: "base", baseRef: "" } },
	].forEach((report) => {
		assert.equal(runGate(t, report).status, 1);
	});
});

test("empty and malformed JSON fail the workflow gate", (t) => {
	["", "not json", "null"].forEach((report) => {
		assert.equal(runGate(t, report).status, 1);
	});
});

test("the workflow preserves nonzero CLI status regardless of report validation", (t) => {
	[validReport, { ...validReport, baselineDegraded: true }, ""].forEach((report) => {
		assert.equal(runGate(t, report, 7).status, 7);
	});
});

test("pinned CLI accepts same-file same-rule replacements but blocks increased counts", { timeout: 180_000 }, (t) => {
	const directory = mkdtempSync(join(tmpdir(), "react-doctor-replacement-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const fixture = new URL("../fixtures/react-doctor-replacement/", import.meta.url);
	writeFileSync(join(directory, "package.json"), readFileSync(new URL("package.json", fixture)));
	writeFileSync(join(directory, "Example.tsx"), readFileSync(new URL("base.tsx", fixture)));

	function git(...args) {
		const result = spawnSync("git", args, {
			cwd: directory,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		assert.equal(result.status, 0, result.stderr);

		return result.stdout.trim();
	}
	function commit(message) {
		git("add", ".");
		git(
			"-c",
			"user.name=CI Fixture",
			"-c",
			"user.email=ci@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			message,
		);
	}
	function scan(...args) {
		const result = spawnSync(
			"pnpm",
			["dlx", "react-doctor@0.9.17", ".", "--json", "--blocking", "error", "--yes", "--no-telemetry", ...args],
			{ cwd: directory, encoding: "utf8", timeout: 60_000 },
		);
		assert.ifError(result.error);
		assert.ok(result.stdout, result.stderr);

		return { status: result.status, report: JSON.parse(result.stdout) };
	}

	git("init", "-q");
	commit("baseline violation");
	const base = git("rev-parse", "HEAD");
	const baseline = scan("--scope", "full");
	assert.equal(baseline.status, 1);
	assert.equal(baseline.report.summary.errorCount, 1);

	writeFileSync(join(directory, "README.md"), "No source changes.\n");
	commit("documentation only");
	const empty = scan("--scope", "changed", "--base", base);
	assert.equal(empty.status, 0);
	assert.equal(empty.report.projects.length, 0);
	assert.equal(runGate(t, empty.report, empty.status).status, 0);

	const headSource = readFileSync(new URL("head.tsx", fixture), "utf8");
	writeFileSync(join(directory, "Example.tsx"), headSource);
	commit("replace violation");
	const head = scan("--scope", "full");
	assert.equal(head.status, 1);
	assert.equal(head.report.summary.errorCount, 1);
	const before = baseline.report.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	const after = head.report.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	assert.equal(before.filePath, after.filePath);
	assert.equal(before.rule, after.rule);
	assert.notEqual(before.line, after.line);

	const replacement = scan("--scope", "changed", "--base", base);
	assert.equal(replacement.status, 0);
	assert.equal(replacement.report.baseline.matchedCount, 1);
	assert.equal(replacement.report.baseline.newCount, 0);
	assert.equal(runGate(t, replacement.report, replacement.status).status, 0);

	writeFileSync(
		join(directory, "Example.tsx"),
		headSource.replace(
			"  const [replacementValue]",
			"  useState('additional violation');\n  const [replacementValue]",
		),
	);
	commit("increase violations");
	const increased = scan("--scope", "changed", "--base", base);
	assert.equal(increased.status, 1);
	assert.equal(increased.report.summary.errorCount, 1);
	assert.equal(runGate(t, increased.report, increased.status).status, 1);
});
