import { readFileSync } from "node:fs";

try {
	const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
	if (
		report?.ok !== true ||
		report.schemaVersion !== 3 ||
		report.version !== "0.9.17" ||
		report.mode !== "baseline" ||
		report.baselineDegraded === true ||
		report.baseline?.source !== "base" ||
		typeof report.baseline.baseRef !== "string" ||
		report.baseline.baseRef.length === 0
	) {
		throw new Error("Expected a successful git baseline comparison from React Doctor 0.9.17.");
	}
	process.stdout.write("React Doctor baseline comparison succeeded.\n");
} catch (error) {
	console.error(`React Doctor report validation failed: ${error.message}.`);
	process.exitCode = 1;
}
