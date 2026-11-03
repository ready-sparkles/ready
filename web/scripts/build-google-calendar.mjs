import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const adapter = new URL("../adapters/primary/google-calendar/", import.meta.url);
const output = new URL("dist/", adapter);
const entry = `export { onHomepage, handleRetryReadyConnection } from "./adapters/primary/google-calendar/homepage.ts";
export { onCreateReadyConference } from "./adapters/primary/google-calendar/conference.ts";
export { debugIdentityAudience, debugVerify } from "./composition/google-calendar/diagnostics.ts";`;

export async function buildAddon() {
	mkdirSync(output, { recursive: true });
	await build({
		stdin: { contents: entry, resolveDir: root, sourcefile: "apps-script-entry.js", loader: "js" },
		/** @external esbuild BuildOptions */
		bundle: true,
		format: "iife",
		globalName: "ReadyAddon",
		platform: "neutral",
		target: "es2020",
		outfile: fileURLToPath(new URL("Implementation.js", output)),
		/** @external esbuild BuildOptions */
		legalComments: "none",
	});
	["Code.js", "appsscript.json"].forEach((name) => {
		copyFileSync(new URL(name, adapter), new URL(name, output));
	});
}

if (process.argv.includes("--write")) {
	await buildAddon();
}
