import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobs = [...workflow.split("\njobs:\n")[1].matchAll(/^ {4}([\w-]+):\n([\s\S]*?)(?=^ {4}[\w-]+:|$(?![\s\S]))/gm)];

test("CI targets GitHub-hosted runners without an ARC selector or runner-admin token", () => {
	assert.deepEqual(
		jobs.map((job) => job[1]),
		["react-doctor", "node", "python"],
	);
	assert.doesNotMatch(workflow, /runner-target|arc-readymeet|ARC_RUNNER_TOKEN|continue-on-error/);
	assert.match(workflow, /\n {4}push:\n {8}branches: \[main\]\n {4}pull_request:\n/);
	assert.match(workflow, /\npermissions:\n {4}contents: read\n/);
	assert.match(workflow, /service: \[livekit-realtime, meeting-agent\]/);
	assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
});

jobs.forEach(([, name, body]) => {
	test(`${name} uses GitHub-hosted runners and excludes fork PRs`, () => {
		assert.match(body, /^ {8}runs-on: ubuntu-latest$/m);
		assert.doesNotMatch(body, /needs:|secrets\./);
		const condition = /^ {8}if: (.+)$/m.exec(body)?.[1];
		assert.ok(condition, `${name} must exclude fork pull requests`);
		[
			["push", undefined, name !== "react-doctor"],
			["pull_request", "ready-sparkles/readymeet", true],
			["pull_request", "contributor/readymeet", false],
		].forEach(([eventName, headRepo, expected]) => {
			const github = {
				event_name: eventName,
				repository: "ready-sparkles/readymeet",
				event: { pull_request: { head: { repo: { full_name: headRepo } } } },
			};
			assert.equal(runInNewContext(condition, { github }), expected, `${eventName}: ${headRepo}`);
		});
	});
});
