import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const publicOutlook = fileURLToPath(new URL("../public/outlook/", import.meta.url));

export async function buildOutlook({ outdir = publicOutlook } = {}) {
	await build({
		absWorkingDir: webRoot,
		entryPoints: {
			core: "adapters/primary/outlook/browser-core.ts",
			"meeting-flow": "adapters/primary/outlook/meeting-flow.ts",
			commands: "adapters/primary/outlook/commands.ts",
			taskpane: "adapters/primary/outlook/taskpane.ts",
			dialog: "adapters/primary/outlook/dialog.ts",
			"command-error": "adapters/primary/outlook/command-error.ts",
		},
		outdir,
		format: "esm",
		platform: "browser",
		target: "es2020",
		/** @external esbuild BuildOptions */
		bundle: true,
		/** @external esbuild BuildOptions */
		splitting: false,
		/** @external esbuild BuildOptions */
		legalComments: "none",
	});
}

if (process.argv.includes("--write")) {
	await buildOutlook();
}
