import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

import { initializeCommands, insertReadyMeeting } from "../../../../adapters/primary/outlook/commands.ts";
import { buildManifest } from "../../../../adapters/primary/outlook/manifest.mjs";
import { addReadyMeeting } from "../../../../adapters/primary/outlook/meeting-flow.ts";
import { REQUEST_KEY } from "../../../../composition/outlook/runtime.ts";

const CLOSED = "Closed";
const OFFICE_UNAVAILABLE = "Office unavailable";
const DIALOG_UNAVAILABLE = "Dialog unavailable";

const PROPERTIES_FAILED = "Could not save properties";
const INSERTION_FAILED = "Insertion failed";

const conference = { code: "test-ready-room", callIn: null };

test("a queued Outlook command starts when the runtime initializes without another click", async () => {
	const handlers = new Map();
	const dispatches = new Map();
	/** @fixtureCapture host call observation */
	const completed = [];
	const event = { completed: (value) => completed.push(value) };
	const office = {
		actions: {
			associate: mock.fn((name, callback) => {
				assert.equal(name, "insertReadyMeeting");
				handlers.set(name, callback);
			}),
		},
		onReady: (callback) => {
			callback();
			// The host dispatches its queued command only after initialization.
			dispatches.set("command", handlers.get("insertReadyMeeting")(event));
		},
	};
	initializeCommands({ office, run: ({ event }) => insertReadyMeeting({ event, create: async () => conference }) });
	assert.ok(dispatches.get("command"), "The host must be initialized before waiting for a command");
	await dispatches.get("command");
	assert.deepEqual(completed, [
		{
			/** @external Host/Ready wire field */ allowEvent: true,
		},
	]);
});
// Owns fake Office host state so retries can observe successful and failed writes.
class ProviderBodyFixture {
	/** @type {string} */
	value = "<p>Existing agenda</p>";
	writes = 0;
	shouldFailBody = false;

	constructor(shouldFailBody) {
		this.shouldFailBody = shouldFailBody;
	}

	getTypeAsync = (done) => done({ status: "succeeded", value: "html" });
	getAsync = mock.fn((_, done) => done({ status: "succeeded", value: this.value }));
	prependAsync = mock.fn((value, _, done) => {
		if (this.shouldFailBody) {
			this.shouldFailBody = false;
			done({ status: "failed", error: { message: INSERTION_FAILED } });

			return;
		}
		this.writes += 1;
		this.value = value + this.value;
		done({ status: "succeeded" });
	});

	setAsync = mock.fn((value, _, done) => {
		this.writes += 1;
		this.value = value;
		done({ status: "succeeded" });
	});
}

function fixture({ shouldFailBody = false, shouldFailProperties = false } = {}) {
	const body = new ProviderBodyFixture(shouldFailBody);
	const props = new Map();
	const properties = {
		get: (key) => props.get(key),
		set: mock.fn((key, value) => props.set(key, value)),
		saveAsync: (done) =>
			done(
				shouldFailProperties
					? { status: "failed", error: { message: PROPERTIES_FAILED } }
					: { status: "succeeded" },
			),
	};
	const item = {
		loadCustomPropertiesAsync: (done) => done({ status: "succeeded", value: properties }),
		getItemIdAsync: (done) => done({ status: "failed", error: { name: "ItemNotSaved" } }),
		subject: { getAsync: (done) => done({ status: "succeeded", value: "Test event" }) },
		saveAsync: () => assert.fail("Must never save or send an appointment"),
		body,
	};

	return {
		office: {
			context: {
				mailbox: { item, userProfile: { emailAddress: "test@ready.test" } },
				requirements: { isSetSupported: () => true },
			},
		},
		read: () => ({ body: body.value, writes: body.writes, props }),
	};
}
test("provider manifest updates the same add-in and contains one function command in v1.1", () => {
	const xml = buildManifest({ baseUrl: "https://ready.app", isProvider: true });
	assert.equal(
		xml,
		readFileSync(new URL("../../../../adapters/primary/outlook/manifest-provider.xml", import.meta.url), "utf8"),
	);
	assert.equal(
		xml,
		readFileSync(new URL("../../../../public/outlook/manifest-provider.xml", import.meta.url), "utf8"),
	);
	assert.match(xml, /<Version>1.1.1.0<\/Version>/);
	assert.match(xml, /<Id>20a9792f-729c-4a96-8292-b52b1c5e7cbb<\/Id>/);
	assert.match(xml, /VersionOverridesV1_1/);
	assert.equal((xml.match(/<Action xsi:type="ExecuteFunction">/g) || []).length, 1);
	assert.match(xml, /<FunctionName>insertReadyMeeting<\/FunctionName>/);
	assert.match(xml, /DefaultValue="Ready meeting"/);
	assert.doesNotMatch(buildManifest(), /ExecuteFunction/);
});

test("provider succeeds only after details are inserted; retry uses same key and preserves agenda", async () => {
	const f = fixture();
	/** @fixtureCapture host call observation */
	const ids = [];
	const create = () =>
		addReadyMeeting({
			office: f.office,
			origin: "https://ready.app",
			openDialog: async ({ title, requestId: id }) => {
				assert.equal(title, "Test event");
				ids.push(id);

				return conference;
			},
		});
	const runCommand = async () => {
		/** @fixtureCapture host call observation */
		const completions = [];
		await insertReadyMeeting({
			event: {
				completed: (result) => {
					assert.match(f.read().body, /test-ready-room/);
					completions.push(result);
				},
			},
			create,
			report: () => assert.fail("No error expected"),
		});
		assert.deepEqual(completions, [
			{
				/** @external Host/Ready wire field */ allowEvent: true,
			},
		]);
	};
	await runCommand();
	await runCommand();
	assert.equal(ids[0], ids[1]);
	assert.equal(f.read().props.get(REQUEST_KEY), ids[0]);
	assert.equal(f.read().writes, 1);
	assert.match(f.read().body, /Existing agenda/);
});

test("failed insertion reports failure and retry completes with the same conference", async () => {
	const f = fixture({ shouldFailBody: true });
	/** @fixtureCapture provider requests */
	const ids = [];
	/** @fixtureCapture host command results */
	const completed = [];
	/** @fixtureCapture host command errors */
	const errors = [];
	const create = () =>
		addReadyMeeting({
			office: f.office,
			origin: "https://ready.app",
			openDialog: async ({ requestId: id }) => {
				ids.push(id);

				return conference;
			},
		});
	const event = { completed: (result) => completed.push(result) };
	await insertReadyMeeting({ event, create, report: async ({ error }) => errors.push(error.message) });
	assert.deepEqual(completed, [
		{
			/** @external Host/Ready wire field */ allowEvent: false,
		},
	]);
	assert.equal(f.read().body, "<p>Existing agenda</p>");
	await insertReadyMeeting({ event, create, report: () => assert.fail("Retry should succeed") });
	assert.deepEqual(completed, [
		{
			/** @external Host/Ready wire field */ allowEvent: false,
		},
		{
			/** @external Host/Ready wire field */ allowEvent: true,
		},
	]);
	assert.deepEqual(errors, ["Insertion failed"]);
	assert.equal(ids[0], ids[1]);
	assert.equal(f.read().writes, 1);
});

test("property-save failure never opens creation dialog or enables the provider", async () => {
	const f = fixture({ shouldFailProperties: true });
	/** @fixtureCapture host call observation */
	const completed = [];
	await insertReadyMeeting({
		event: { completed: (value) => completed.push(value) },
		create: () =>
			addReadyMeeting({
				office: f.office,
				origin: "https://ready.app",
				openDialog: () => assert.fail("No room should be created"),
			}),
		report: async () => {},
	});
	assert.deepEqual(completed, [
		{
			/** @external Host/Ready wire field */ allowEvent: false,
		},
	]);
	assert.equal(f.read().writes, 0);
});

test("cancellation releases the command once without opening a second dialog", async () => {
	/** @fixtureCapture host call observation */
	const completed = [];
	await insertReadyMeeting({
		event: { completed: (value) => completed.push(value) },
		create: async () => {
			throw Object.assign(new Error(CLOSED), {
				/** @external Host/Ready wire field */ cancelled: true,
			});
		},
		report: () => assert.fail("Do not show an error on cancellation"),
	});
	assert.deepEqual(completed, [
		{
			/** @external Host/Ready wire field */ allowEvent: false,
		},
	]);
});

test("error-dialog failure still completes the command with failure", async () => {
	/** @fixtureCapture host call observation */
	const completed = [];
	await insertReadyMeeting({
		event: { completed: (value) => completed.push(value) },
		create: async () => {
			throw new Error(OFFICE_UNAVAILABLE);
		},
		report: async () => {
			throw new Error(DIALOG_UNAVAILABLE);
		},
	});
	assert.deepEqual(completed, [
		{
			/** @external Host/Ready wire field */ allowEvent: false,
		},
	]);
});
