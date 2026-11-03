import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRECTORIES = ["plans/", ".agents/", ".claude/"];
const EXCLUDED_FILES = new Set(["AGENTS.md", "skills-lock.json"]);
const SNAPSHOT_COMMIT_MESSAGE = "Publish the Ready source snapshot under BUSL-1.1.";

export function isPublicSnapshotPath(filePath) {
	const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (EXCLUDED_FILES.has(normalized)) {
		return false;
	}

	return !EXCLUDED_DIRECTORIES.some((directory) => normalized.startsWith(directory));
}

function archiveExcludes() {
	const directories = EXCLUDED_DIRECTORIES.map((directory) => `:(exclude)${directory.slice(0, -1)}`);
	const files = [...EXCLUDED_FILES].map((file) => `:(exclude)${file}`);

	return [...directories, ...files];
}

function readGitConfig(repoRoot, key) {
	const result = spawnSync("git", ["config", "--get", key], { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) {
		return "";
	}

	return result.stdout.trim();
}

function snapshotGitEnv(repoRoot) {
	const name = process.env.GIT_AUTHOR_NAME || readGitConfig(repoRoot, "user.name");
	const email = process.env.GIT_AUTHOR_EMAIL || readGitConfig(repoRoot, "user.email");
	if (!name || !email) {
		throw new Error("Set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL, or git user.name and user.email, before exporting.");
	}

	return {
		...process.env,
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || name,
		GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || email,
	};
}

function runGit(repoRoot, args, env) {
	const result = spawnSync("git", args, { cwd: repoRoot, env, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout || "").trim() || `git ${args.join(" ")} failed.`);
	}
}

function isInsideRepository(sourceRoot, destination) {
	const relativeDestination = relative(sourceRoot, destination);

	return relativeDestination === "" || !relativeDestination.startsWith("..");
}

function extractCommittedTree(sourceRoot, snapshotRoot) {
	const scratch = mkdtempSync(join(tmpdir(), "ready-archive-"));
	const archivePath = join(scratch, "snapshot.tar");
	try {
		runGit(
			sourceRoot,
			["archive", `--output=${archivePath}`, "HEAD", "--", ".", ...archiveExcludes()],
			process.env,
		);
		const extracted = spawnSync("tar", ["-x", "-f", archivePath, "-C", snapshotRoot], { encoding: "utf8" });
		if (extracted.status !== 0) {
			throw new Error(extracted.stderr.trim() || "Extracting the committed tree failed.");
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function exportPublicSnapshot({ repoRoot, destination }) {
	const sourceRoot = resolve(repoRoot);
	const snapshotRoot = resolve(destination);
	if (isInsideRepository(sourceRoot, snapshotRoot)) {
		throw new Error("Destination must be outside the source repository.");
	}
	if (existsSync(snapshotRoot)) {
		throw new Error("Destination already exists.");
	}

	mkdirSync(snapshotRoot, { recursive: true });
	try {
		extractCommittedTree(sourceRoot, snapshotRoot);
		if (!existsSync(join(snapshotRoot, "LICENSE"))) {
			throw new Error("Refusing to export a snapshot without LICENSE.");
		}
		const env = snapshotGitEnv(sourceRoot);
		runGit(snapshotRoot, ["init", "-b", "main"], env);
		runGit(snapshotRoot, ["add", "--all", "--force"], env);
		runGit(snapshotRoot, ["commit", "--message", SNAPSHOT_COMMIT_MESSAGE], env);
	} catch (error) {
		rmSync(snapshotRoot, { recursive: true, force: true });
		throw error;
	}

	return snapshotRoot;
}

function isDirectRun() {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}

	return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
	const destination = process.argv[2];
	if (!destination) {
		process.stderr.write("Usage: node scripts/export-public-snapshot.mjs <destination>\n");
		process.exitCode = 1;
	} else {
		try {
			const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
			const snapshotRoot = exportPublicSnapshot({ repoRoot, destination });
			process.stdout.write(`Exported the latest commit to ${snapshotRoot}.\n`);
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
