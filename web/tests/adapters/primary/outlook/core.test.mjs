import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { z } from "zod";

import { compiledFormatter } from "../../../../adapters/primary/outlook/build-formatter.mjs";
import { buildManifest } from "../../../../adapters/primary/outlook/manifest.mjs";
import {
	CONFERENCE_KEY,
	containsConference,
	getRequestId,
	insertConference,
	invitation,
	parseConference,
	readDialogMessage,
	readResponseJson,
	REQUEST_KEY,
	requestIdForItem,
	signInAgain,
	validRequestId,
} from "../../../../composition/outlook/runtime.ts";
import { buildOutlook } from "../../../../scripts/build-outlook.mjs";

const formBodySchema = z.instanceof(URLSearchParams);
const conferenceFixtureSchema = z.object({
	code: z.string(),
	callIn: z.object({ phoneNumber: z.string(), pin: z.string() }).nullable(),
});
const HTTPS_EVIL_TEST = "https://evil.test";
const CONCURRENT_REQUEST_COUNT = 5;
const NEW_LIVE_ROOM = "new-live-room";
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;
const PLEASE_TRY_AGAIN = "Please try again.";
const REPLACEMENT_ROOM = "replacement-room";
const INSERT_FAILED = "Insert failed";

const SAVE_FAILED = "Save failed";

const origin = "https://ready.app";
const conference = { code: "abc-def-ghi", callIn: { phoneNumber: "+1 555 123 4567", pin: "123456" } };

test("dialog results require the exact trusted origin and nonce and cannot supply arbitrary links or markup", () => {
	const event = { origin, message: JSON.stringify({ type: "ready-conference", nonce: "expected", conference }) };
	assert.deepEqual(readDialogMessage({ event, origin, nonce: "expected" }), conference);
	assert.equal(
		readDialogMessage({ event: { ...event, origin: "https://evil.test" }, origin, nonce: "expected" }),
		null,
	);
	assert.equal(readDialogMessage({ event: { message: event.message }, origin, nonce: "expected" }), null);
	assert.equal(readDialogMessage({ event, origin, nonce: "other-window" }), null);
	assert.equal(parseConference({ code: HTTPS_EVIL_TEST }), null);
	assert.deepEqual(parseConference({ ...conference, callIn: { phoneNumber: "<script>", pin: "1" } }), {
		code: conference.code,
		callIn: null,
	});
	assert.deepEqual(parseConference({ ...conference, callIn: { phoneNumber: "+15551234", pin: "<img>" } }), {
		code: conference.code,
		callIn: null,
	});
});

test("invitation uses real Ready room URLs and tolerates unavailable dial-in", () => {
	assert.match(invitation({ origin, conference, isHtml: true }), /href="https:\/\/ready.app\/abc-def-ghi"/);
	assert.match(invitation({ origin, conference, isHtml: false }), /PIN: 123456#/);
	assert.doesNotMatch(invitation({ origin, conference: { ...conference, callIn: null }, isHtml: true }), /Dial-in/);
	assert.equal(containsConference({ body: "https://ready.app/abc-def-ghij", origin, conference }), false);
	assert.equal(
		containsConference({ body: invitation({ origin, conference, isHtml: true }), origin, conference }),
		true,
	);
});

// Models the Office host's mutable invitation body, not application state.
class AppointmentBodyFixture {
	/** @type {string} */
	value = "";
	inserts = 0;
	shouldFailInsert = false;

	constructor({ isHtml, shouldFailInsert }) {
		this.value = isHtml ? "<p>Keep this agenda &amp; attachments.</p>" : "Keep this agenda.";
		this.shouldFailInsert = shouldFailInsert;
		this.getTypeAsync = (done) => done({ status: "succeeded", value: isHtml ? "html" : "text" });
	}

	getAsync = mock.fn((_, done) => done({ status: "succeeded", value: this.value }));
	setAsync = mock.fn((value, _, done) => {
		this.value = value;
		done({ status: "succeeded" });
	});

	prependAsync = mock.fn((value, _, done) => {
		if (this.shouldFailInsert) {
			this.shouldFailInsert = false;
			done({ status: "failed", error: { message: INSERT_FAILED } });

			return;
		}
		this.inserts += 1;
		this.value = value + this.value;
		done({ status: "succeeded" });
	});
}

function fixture({ isHtml = true, shouldFailSave = false, shouldFailInsert = false } = {}) {
	const body = new AppointmentBodyFixture({ isHtml, shouldFailInsert });
	const values = {};

	return {
		properties: {
			get: (key) => values[key],
			set: mock.fn((key, value) => {
				values[key] = value;
			}),
			saveAsync: (done) =>
				done(shouldFailSave ? { status: "failed", error: { message: SAVE_FAILED } } : { status: "succeeded" }),
		},
		item: { body },
		read: () => ({ body: body.value, inserts: body.inserts, values }),
	};
}
await [true, false].reduce(async (previous, isHtml) => {
	await previous;
	test(`retry preserves agenda and inserts once (${isHtml ? "HTML" : "text"})`, async () => {
		const f = fixture({ isHtml });
		await insertConference({ item: f.item, properties: f.properties, conference, origin });
		await insertConference({ item: f.item, properties: f.properties, conference, origin });
		assert.equal(f.read().inserts, 1);
		assert.match(f.read().body, /Keep this agenda/);
	});
}, Promise.resolve());

test("property-save failure leaves the invitation untouched", async () => {
	const f = fixture({ shouldFailSave: true });
	await assert.rejects(
		insertConference({ item: f.item, properties: f.properties, conference, origin }),
		/Save failed/,
	);
	assert.equal(f.read().inserts, 0);
});

test("failed body insertion retains the conference so retry does not create a new room", async () => {
	const f = fixture({ shouldFailInsert: true });
	await assert.rejects(
		insertConference({ item: f.item, properties: f.properties, conference, origin }),
		/Insert failed/,
	);
	const recovered = parseConference(conferenceFixtureSchema.parse(JSON.parse(f.read().values[CONFERENCE_KEY])));
	await insertConference({ item: f.item, properties: f.properties, conference: recovered, origin });
	assert.equal(f.read().inserts, 1);
});

test("concurrent first use derives the same key, distinct mailboxes and items do not collide", async () => {
	const keys = await Promise.all(
		Array.from({ length: CONCURRENT_REQUEST_COUNT }, () =>
			requestIdForItem({ mailbox: "Personbr@Example.com", itemId: "saved-item-id" }),
		),
	);
	assert.equal(new Set(keys).size, 1);
	assert.equal(validRequestId(keys[0]), true);
	assert.equal(keys[0], await requestIdForItem({ mailbox: "personbr@example.com", itemId: "saved-item-id" }));
	assert.notEqual(keys[0], await requestIdForItem({ mailbox: "other@example.com", itemId: "saved-item-id" }));
	assert.notEqual(keys[0], await requestIdForItem({ mailbox: "personbr@example.com", itemId: "another-item" }));
});

test("manifest is reproducible and preview origins cannot inject XML or insecure URLs", () => {
	assert.equal(
		readFileSync(new URL("../../../../adapters/primary/outlook/manifest.xml", import.meta.url), "utf8"),
		buildManifest(),
	);
	assert.equal(
		readFileSync(new URL("../../../../public/outlook/manifest.xml", import.meta.url), "utf8"),
		buildManifest(),
	);
	assert.match(
		buildManifest({ baseUrl: "https://localhost:3000" }),
		/https:\/\/localhost:3000\/outlook\/taskpane.html/,
	);
	assert.throws(() => buildManifest({ baseUrl: "http://ready.app" }));
	assert.throws(() => buildManifest({ baseUrl: "https://user:pass@example.com" }));
	assert.throws(() => buildManifest({ baseUrl: "https://ready.app/path" }));
});

test("edited appointments never save or send when deriving their retry key", async () => {
	const f = fixture();
	const item = {
		getItemIdAsync: (done) => done({ status: "succeeded", value: "existing-meeting" }),
		saveAsync: () => assert.fail("Must never save an appointment"),
	};
	const id = await getRequestId({ item, properties: f.properties, mailbox: "personbr@example.com" });
	assert.equal(id, await requestIdForItem({ mailbox: "personbr@example.com", itemId: "existing-meeting" }));
	assert.equal(await getRequestId({ item, properties: f.properties, mailbox: "personbr@example.com" }), id);
});

test("unsaved events use a persisted random key and never save the appointment", async () => {
	const f = fixture();
	const item = {
		getItemIdAsync: (done) => done({ status: "failed", error: { name: "ItemNotSaved" } }),
		saveAsync: () => assert.fail("Must never save an appointment"),
	};
	const id = await getRequestId({ item, properties: f.properties, mailbox: "personbr@example.com" });
	assert.equal(validRequestId(id), true);
	assert.equal(f.read().values[REQUEST_KEY], id);
	assert.equal(await getRequestId({ item, properties: f.properties, mailbox: "personbr@example.com" }), id);
	await assert.rejects(
		getRequestId({
			item: { getItemIdAsync: (done) => done({ status: "failed", error: { name: "NetworkError" } }) },
			properties: fixture().properties,
			mailbox: "personbr@example.com",
		}),
		/Could not read/,
	);
});

test("unsupported clients see a useful static fallback even when modules never parse", () => {
	["taskpane.html", "dialog.html"].forEach((file) => {
		assert.match(
			readFileSync(new URL(`../../../../public/outlook/${file}`, import.meta.url), "utf8"),
			/Please update Outlook or open this event in Outlook on the web/,
		);
	});
	assert.match(buildManifest(), /MinVersion="1.8"/);
});

test("optional dial-in failures retain a usable room and foreign numbers are not marked US", () => {
	["+358.40.1234567", "tel:+358401234567 ext. 1", "<img src=x>", "", null].forEach((phoneNumber) => {
		const parsed = parseConference({ ...conference, callIn: { phoneNumber, pin: "12345" } });
		assert.equal(parsed.code, conference.code);
		assert.match(invitation({ origin, conference: parsed, isHtml: true }), /Join meeting/);
		assert.doesNotMatch(invitation({ origin, conference: parsed, isHtml: true }), /\(US\)|<img/);
	});
});

test("complete links followed by punctuation are recognized without accepting code prefixes", () => {
	[".", ")", ",", ";", ":", "!", "]", "?x=1", "#join", " "].forEach((suffix) => {
		assert.equal(
			containsConference({ body: `Join https://ready.app/${conference.code}${suffix}`, origin, conference }),
			true,
			suffix,
		);
	});
	["j", "-other", "/other"].forEach((suffix) => {
		assert.equal(
			containsConference({ body: `https://ready.app/${conference.code}${suffix}`, origin, conference }),
			false,
		);
	});
});

test("replacement refreshes only the managed HTML block and preserves the agenda", async () => {
	const f = fixture();
	await insertConference({ item: f.item, properties: f.properties, conference, origin });
	await insertConference({
		item: f.item,
		properties: f.properties,
		conference: { code: NEW_LIVE_ROOM, callIn: null },
		origin,
	});
	assert.doesNotMatch(f.read().body, /abc-def-ghi|123456#/);
	assert.match(f.read().body, /new-live-room/);
	assert.match(f.read().body, /Keep this agenda &amp; attachments/);
});

test("shared invitation formatter browser artifact matches its source", async () => {
	// ESLint padding fixes add blank lines to the committed artifact; compare the code itself.
	const withoutBlankLines = (text) => text.replace(/\n\s*\n/g, "\n");
	assert.equal(
		withoutBlankLines(
			readFileSync(new URL("../../../../public/outlook/calendar-description.js", import.meta.url), "utf8"),
		),
		withoutBlankLines(await compiledFormatter()),
	);
});

test("HTML and malformed proxy errors become useful messages, never JSON parse errors", async () => {
	await [HTTP_OK, HTTP_UNAUTHORIZED, HTTP_INTERNAL_ERROR, HTTP_BAD_GATEWAY, HTTP_GATEWAY_TIMEOUT].reduce(
		async (previous, status) => {
			await previous;
			await assert.rejects(
				readResponseJson({
					response: new Response("<html>Gateway error</html>", { status }),
					fallback: PLEASE_TRY_AGAIN,
				}),
				{ message: PLEASE_TRY_AGAIN },
			);
		},
		Promise.resolve(),
	);
});

test("account switch clears the stale session with CSRF and retains the dialog callback", async () => {
	/** @fixtureCapture host call observation */
	const calls = [];
	const callback = "/outlook/dialog.html#requestId=one&nonce=two";
	const login = await signInAgain({
		callbackUrl: callback,
		fetcher: async (...[url, options]) => {
			calls.push({ url, options });

			return Response.json(
				url.endsWith("csrf") ? { csrfToken: "test-csrf" } : { url: "https://untrusted.invalid" },
			);
		},
	});
	assert.equal(calls[0].url, "/api/auth/csrf");
	assert.equal(calls[1].url, "/api/auth/signout");
	assert.equal(calls[1].options.method, "POST");
	assert.equal(formBodySchema.parse(calls[1].options.body).get("csrfToken"), "test-csrf");
	assert.equal(new URL(login, origin).searchParams.get("callbackUrl"), callback);
	await assert.rejects(
		signInAgain({
			callbackUrl: callback,
			fetcher: async () => new Response("<html>", { status: HTTP_BAD_GATEWAY }),
		}),
		/Could not start sign-in/,
	);
});

test("the real pane revalidates cached conferences and never saves edited appointments", async () => {
	const f = fixture();
	await insertConference({ item: f.item, properties: f.properties, conference, origin });
	const elements = Object.fromEntries(
		["#add", "#status", "#join"].map((key) => [
			key,
			{
				addEventListener: mock.fn((_, handler) => {
					elements[key].click = handler;
				}),
			},
		]),
	);
	const saved = { Office: globalThis.Office, document: globalThis.document, location: globalThis.location };
	const dialogCalls = new Set();
	try {
		globalThis.document = { querySelector: (key) => elements[key] };
		globalThis.location = { origin };
		const item = {
			...f.item,
			loadCustomPropertiesAsync: (done) => done({ status: "succeeded", value: f.properties }),
			getItemIdAsync: (done) => done({ status: "succeeded", value: "edited-item" }),
			saveAsync: () => assert.fail("Appointment save can send updates"),
			subject: { getAsync: (done) => done({ status: "succeeded", value: "Edited meeting" }) },
		};
		globalThis.Office = {
			onReady: (callback) => callback({ host: "Outlook" }),
			HostType: { Outlook: "Outlook" },
			EventType: { DialogMessageReceived: "message", DialogEventReceived: "closed" },
			context: {
				mailbox: { item, userProfile: { emailAddress: "personbr@example.com" } },
				requirements: { isSetSupported: () => true },
				ui: {
					displayDialogAsync: mock.fn((url, _, done) => {
						dialogCalls.add(Symbol());
						const nonce = new URLSearchParams(new URL(url).hash.slice(1)).get("nonce");
						done({
							status: "succeeded",
							value: {
								close() {},
								addEventHandler: mock.fn((type, callback) => {
									if (type === "message") {
										callback({
											origin,
											message: JSON.stringify({
												type: "ready-conference",
												nonce,
												conference: { code: REPLACEMENT_ROOM, callIn: null },
											}),
										});
									}
								}),
							},
						});
					}),
				},
			},
		};
		await import("../../../../adapters/primary/outlook/taskpane.ts");
		await elements["#add"].click();
		assert.equal(dialogCalls.size, 1);
		assert.match(f.read().body, /replacement-room/);
		assert.doesNotMatch(f.read().body, /abc-def-ghi/);
		assert.match(elements["#status"].textContent, /Ready meeting added/);
	} finally {
		Object.assign(globalThis, saved);
	}
});

test("the real dialog exposes reauthentication after a non-JSON 401 and supports account switching", async () => {
	const elements = Object.fromEntries(
		["#status", "#confirm", "#signin", "#title"].map((key) => [
			key,
			{
				/** @external Host/Ready wire field */
				hidden: true,
				addEventListener: mock.fn((_, handler) => {
					elements[key].click = handler;
				}),
			},
		]),
	);
	const saved = {
		Office: globalThis.Office,
		document: globalThis.document,
		location: globalThis.location,
		fetch: globalThis.fetch,
	};
	const readiness = mock.fn((callback) => callback());
	const navigate = mock.fn();
	try {
		globalThis.document = { querySelector: (key) => elements[key] };
		globalThis.location = {
			origin,
			hash: "#title=Test&requestId=20a9792f-729c-4a96-8292-b52b1c5e7cbb&nonce=20a9792f-729c-4a96-8292-b52b1c5e7cbb",
			assign: navigate,
		};
		globalThis.Office = {
			onReady: readiness,
		};
		globalThis.fetch = async (url) => {
			if (url === "/api/outlook/session") {
				return Response.json({ user: { email: "wrong@ready.test" } });
			}
			if (url === "/api/auth/csrf") {
				return Response.json({ csrfToken: "csrf-test" });
			}
			if (url === "/api/auth/signout") {
				return Response.json({ url: "/login" });
			}

			return new Response("<html>Expired</html>", { status: HTTP_UNAUTHORIZED });
		};
		await import("../../../../adapters/primary/outlook/dialog.ts");
		await readiness.mock.calls[0].result;
		assert.equal(elements["#signin"].hidden, false);
		assert.equal(elements["#signin"].textContent, "Switch Ready account");
		await elements["#confirm"].click();
		assert.equal(elements["#confirm"].hidden, true);
		assert.equal(elements["#signin"].hidden, false);
		assert.equal(elements["#status"].textContent, "Your session expired. Sign in again.");
		const steps = mock.fn();
		const fetchBeforeSwitch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			steps(`fetch ${url}`);

			return fetchBeforeSwitch(url, init);
		};
		navigate.mock.mockImplementation(() => steps("navigate"));
		const switching = elements["#signin"].click({ preventDefault: () => steps("preventDefault") });
		assert.equal(
			steps.mock.calls[0]?.arguments[0],
			"preventDefault",
			"the /login link must not navigate before sign-out finishes",
		);
		await switching;
		assert.deepEqual(
			steps.mock.calls.map((call) => call.arguments[0]),
			["preventDefault", "fetch /api/auth/csrf", "fetch /api/auth/signout", "navigate"],
		);
		assert.equal(
			new URL(navigate.mock.calls[0].arguments[0], origin).searchParams.get("callbackUrl"),
			`/outlook/dialog.html${globalThis.location.hash}`,
		);
	} finally {
		Object.assign(globalThis, saved);
	}
});

await [true, false].reduce(async (previous, isHtml) => {
	await previous;
	test(`disabled-room replacement repairs legacy invitations and survives insertion failure (${isHtml ? "HTML" : "text"})`, async () => {
		const f = fixture({ isHtml });
		const url = `${origin}/${conference.code}`;
		const dial = `Dial-in: (US) ${conference.callIn.phoneNumber} PIN: ${conference.callIn.pin}#`;
		const legacy = isHtml
			? `<div><p><strong>Join meeting:</strong> <a href="${url}">${url}</a></p><p>${dial}</p></div><br>`
			: `Join meeting: ${url}\n${dial}\n\n`;
		f.item.body.setAsync(legacy + f.read().body, {}, () => {});
		f.properties.set(CONFERENCE_KEY, JSON.stringify(conference));
		const replacement = { code: NEW_LIVE_ROOM, callIn: null };
		const set = f.item.body.setAsync;
		f.item.body.setAsync = mock.fn((_, __, done) => done({ status: "failed", error: { message: INSERT_FAILED } }));
		await assert.rejects(
			insertConference({ item: f.item, properties: f.properties, conference: replacement, origin }),
			/Insert failed/,
		);
		f.item.body.setAsync = set;
		await insertConference({ item: f.item, properties: f.properties, conference: replacement, origin });
		assert.doesNotMatch(f.read().body, /abc-def-ghi|123456#/);
		assert.match(f.read().body, /new-live-room/);
		assert.match(f.read().body, /Keep this agenda/);
	});
}, Promise.resolve());

test("outlook browser bundles match the TypeScript sources", async () => {
	const outdir = mkdtempSync(join(tmpdir(), "outlook-"));
	await buildOutlook({ outdir });
	["core.js", "meeting-flow.js", "commands.js", "taskpane.js", "dialog.js", "command-error.js"].forEach((name) => {
		assert.equal(
			readFileSync(new URL(`../../../../public/outlook/${name}`, import.meta.url), "utf8"),
			readFileSync(join(outdir, name), "utf8"),
		);
	});
});

void test("browser-served Outlook modules import only relative paths the browser can resolve", () => {
	const outlookDirectory = new URL("../../../../public/outlook/", import.meta.url);
	const moduleFiles = readdirSync(outlookDirectory).filter((name) => name.endsWith(".js"));
	assert.notEqual(moduleFiles.length, 0);
	moduleFiles.forEach((name) => {
		const source = readFileSync(new URL(name, outlookDirectory), "utf8");
		const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g)].map(
			(match) => match[1],
		);
		specifiers.forEach((specifier) => {
			assert.match(specifier, /^\.\.?\//, `${name} imports bare specifier ${specifier}`);
		});
	});
});
