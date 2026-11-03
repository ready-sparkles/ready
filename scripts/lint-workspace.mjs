import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// One ESLint process over the whole repository keeps every type-aware program
// alive at once and exceeds the default heap on CI runners. Linting the large
// workspaces in separate processes covers the same files with bounded memory.
const SEPARATE_TARGETS = ["web", "api", "assistant", "db", "shared"];
const HEAP_MEGABYTES = 6144;
const eslintBin = fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url));
const forwardedArgs = process.argv.slice(2);
const remainderArgs = [".", ...SEPARATE_TARGETS.flatMap((target) => ["--ignore-pattern", `${target}/**`])];
const runs = [...SEPARATE_TARGETS.map((target) => [target]), remainderArgs];
const failures = runs.filter((targetArgs) => {
	process.stdout.write(`eslint ${targetArgs[0]}\n`);
	const result = spawnSync(
		process.execPath,
		[`--max-old-space-size=${HEAP_MEGABYTES}`, eslintBin, ...targetArgs, "--max-warnings", "0", ...forwardedArgs],
		{ stdio: "inherit" },
	);

	return result.status !== 0;
});
if (failures.length > 0) {
	process.stderr.write(`ESLint failed for: ${failures.map((targetArgs) => targetArgs[0]).join(", ")}.\n`);
	process.exitCode = 1;
}
