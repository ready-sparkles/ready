import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mock, test } from "node:test";
import vm from "node:vm";
import { z } from "zod";

const READY_CODE = "ready-code";
const REFRESH_REQUEST_COUNT = 3;

const manifestSchema = z
	.object({
		oauthScopes: z.array(z.string()),
		addOns: z
			.object({
				common: z.object({ homepageTrigger: z.object({ runFunction: z.string() }) }).passthrough(),
				calendar: z
					.object({
						conferenceSolution: z.array(
							z.object({ id: z.string(), onCreateFunction: z.string() }).passthrough(),
						),
					})
					.passthrough(),
			})
			.passthrough(),
	})
	.passthrough();
const claspSchema = z.object({ rootDir: z.string(), filePushOrder: z.array(z.string()) }).passthrough();
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const handlers = [
	"onHomepage",
	"onCreateReadyConference",
	"handleRetryReadyConnection",
	"debugIdentityAudience",
	"debugVerify",
];

function builder() {
	const fields = new Map();
	const entries = [];

	const host = {
		setConferenceSolutionId: (value) => fluent({ key: "solution", value }),
		setConferenceId: (value) => fluent({ key: "id", value }),
		addEntryPoint: (value) => {
			fields.set(`entry-${fields.size}`, value);

			return host;
		},
		setEntryPointType: (value) => fluent({ key: "type", value }),
		setUri: (value) => fluent({ key: "uri", value }),
		setRegionCode: (value) => fluent({ key: "region", value }),
		setPin: (value) => fluent({ key: "pin", value }),
		setConferenceErrorType: (value) => fluent({ key: "errorType", value }),
		setAuthenticationUrl: (value) => fluent({ key: "authenticationUrl", value }),
		setError: (value) => fluent({ key: "error", value }),
		setText: (value) => fluent({ key: "text", value }),
		setTitle: (value) => fluent({ key: "title", value }),
		setHeader: (value) => fluent({ key: "header", value }),
		addSection: (value) => fluent({ key: "section", value }),
		addWidget: (value) => fluent({ key: "widget", value }),
		setOnClickAction: (value) => fluent({ key: "action", value }),
		setFunctionName: (value) => fluent({ key: "function", value }),
		setOpenLink: (value) => fluent({ key: "link", value }),
		setUrl: (value) => fluent({ key: "url", value }),
		setNavigation: (value) => fluent({ key: "navigation", value }),
		updateCard: (value) => fluent({ key: "card", value }),
		build: () => Object.fromEntries(fields),
		fields,
		entries,
	};

	function fluent({ key, value }) {
		fields.set(key, value);

		return host;
	}

	return host;
}

function hostFixture() {
	const caches = new Map();
	const authorization = mock.fn();
	const fixtureAuth = {
		token: "fresh-token",
		/** @external Ready wire field */ accountCreated: true,
		user: { id: "id", email: "person@example.com" },
		webHandoffId: "handoff",
		webHandoffToken: "signed",
	};
	const fetch = mock.fn((url, options) => ({
		getResponseCode: () => (options.headers?.Authorization === "Bearer stale-token" ? HTTP_UNAUTHORIZED : HTTP_OK),
		getContentText: () =>
			JSON.stringify(
				url.endsWith("login")
					? fixtureAuth
					: { meetingLink: { code: READY_CODE, callIn: { phoneNumber: "+15551234", pin: "123" } } },
			),
	}));
	const context = {
		ScriptApp: {
			AuthMode: { FULL: "FULL" },
			requireAllScopes: authorization,
			getIdentityToken: () => "header.payload.signature",
			getOAuthToken: () => "calendar-token",
		},
		CacheService: {
			getUserCache: () => ({
				get: (key) => caches.get(key),
				put: mock.fn((key, value) => caches.set(key, value)),
				remove: (key) => caches.delete(key),
			}),
		},
		PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
		UrlFetchApp: { fetch },
		Utilities: {
			base64DecodeWebSafe: (value) => value,
			newBlob: () => ({ getDataAsString: () => JSON.stringify({ aud: "audience" }) }),
		},
		ConferenceDataService: {
			EntryPointType: { VIDEO: "VIDEO", PHONE: "PHONE" },
			ConferenceErrorType: { AUTHENTICATION: "AUTHENTICATION", TEMPORARY: "TEMPORARY" },
			newConferenceDataBuilder: builder,
			newEntryPoint: builder,
			newConferenceError: builder,
		},
		CardService: Object.fromEntries(
			[
				"newCardSection",
				"newTextParagraph",
				"newCardBuilder",
				"newCardHeader",
				"newTextButton",
				"newAction",
				"newOpenLink",
				"newActionResponseBuilder",
				"newNavigation",
			].map((name) => [name, builder]),
		),
		console: { error: mock.fn(), info: mock.fn(), warn: mock.fn() },
	};
	vm.createContext(context);
	["Implementation.js", "Code.js"].forEach((name) => {
		vm.runInContext(
			readFileSync(new URL(`../../../../adapters/primary/google-calendar/dist/${name}`, import.meta.url), "utf8"),
			context,
			{ filename: name },
		);
	});

	return { context, caches, authorization, fetch };
}

test("clasp deploys only the built implementation, unchanged manifest and public wrappers in order", () => {
	const clasp = claspSchema.parse(
		JSON.parse(
			readFileSync(new URL("../../../../adapters/primary/google-calendar/.clasp.json", import.meta.url), "utf8"),
		),
	);
	assert.equal(clasp.rootDir, "dist");
	assert.deepEqual(clasp.filePushOrder, ["Implementation.js", "Code.js"]);
	assert.deepEqual(
		readdirSync(new URL("../../../../adapters/primary/google-calendar/dist/", import.meta.url)).toSorted(),
		["Code.js", "Implementation.js", "appsscript.json"],
	);
	["Code.js", "appsscript.json"].forEach((name) => {
		assert.equal(
			readFileSync(new URL(`../../../../adapters/primary/google-calendar/${name}`, import.meta.url), "utf8"),
			readFileSync(new URL(`../../../../adapters/primary/google-calendar/dist/${name}`, import.meta.url), "utf8"),
		);
	});
	const manifest = manifestSchema.parse(
		JSON.parse(
			readFileSync(
				new URL("../../../../adapters/primary/google-calendar/dist/appsscript.json", import.meta.url),
				"utf8",
			),
		),
	);
	assert.equal(manifest.addOns.common.homepageTrigger.runFunction, "onHomepage");
	assert.equal(manifest.addOns.calendar.conferenceSolution[0].onCreateFunction, "onCreateReadyConference");
	assert.equal(manifest.addOns.calendar.conferenceSolution[0].id, "ready-meeting");
	const { context } = hostFixture();
	handlers.forEach((name) => {
		assert.equal(typeof context[name], "function", name);
	});
});

test("the deployable conference handler refreshes a revoked cache once and retains video and phone", () => {
	const { context, caches, authorization, fetch } = hostFixture();
	caches.set("ready-auth-v2", JSON.stringify({ token: "stale-token" }));
	const conference = context.onCreateReadyConference({ calendar: { calendarId: "primary", eventId: "event" } });
	assert.equal(authorization.mock.callCount(), 1);
	assert.equal(fetch.mock.callCount(), REFRESH_REQUEST_COUNT);
	assert.equal(conference.solution, "ready-meeting");
	assert.equal(conference.id, "ready-code");
	const entryPoints = Object.values(conference)
		.filter((value) => typeof value === "object")
		.map((value) => Object.fromEntries(value.fields));
	assert.deepEqual(
		entryPoints.map((entry) => entry.type),
		["VIDEO", "PHONE"],
	);
	assert.equal(entryPoints[0].uri, "https://ready.app/ready-code");
	assert.equal(entryPoints[1].uri, "tel:+15551234,,,123");
	assert.equal(entryPoints[1].pin, "123#");
});

test("the deployable sidebar, retry and editor diagnostics remain synchronous callable globals", () => {
	const { context, caches } = hostFixture();
	assert.equal(context.onHomepage().header.fields.get("title"), "Your free Ready account is ready");
	assert.equal(caches.has("ready-auth-v2"), true);
	assert.ok(context.handleRetryReadyConnection().navigation.fields.has("card"));
	assert.equal(context.debugIdentityAudience(), "audience");
	assert.equal(context.debugVerify(), undefined);
});

const AUTH_REQUIRED_MESSAGE = "Authorization required";
const PHONE_FAILED_MESSAGE = "Phone builder unavailable";
const API_UNAVAILABLE_MESSAGE = "API unavailable";

test("the deployable callback requests scopes before using identity, cache or HTTP", () => {
	const { context, fetch } = hostFixture();
	const authorizationError = new Error(AUTH_REQUIRED_MESSAGE);
	context.ScriptApp.requireAllScopes = () => {
		throw authorizationError;
	};
	assert.throws(
		() => context.onCreateReadyConference({ calendar: { calendarId: "primary", eventId: "event" } }),
		authorizationError,
	);
	assert.equal(fetch.mock.callCount(), 0);
});

test("the deployable callback still returns a video link when the phone builder fails", () => {
	const { context } = hostFixture();
	const newEntry = context.ConferenceDataService.newEntryPoint;
	context.ConferenceDataService.newEntryPoint = () => {
		const entry = newEntry();
		entry.setPin = () => {
			throw new Error(PHONE_FAILED_MESSAGE);
		};

		return entry;
	};
	const conference = context.onCreateReadyConference({ calendar: { calendarId: "primary", eventId: "event" } });
	const entry = Object.values(conference).find((value) => typeof value === "object");
	assert.equal(conference.id, "ready-code");
	assert.equal(entry.fields.get("type"), "VIDEO");
	assert.equal(entry.fields.get("uri"), "https://ready.app/ready-code");
});

test("the deployable callback surfaces a repeated 401 without a second refresh", () => {
	const { context, caches, fetch } = hostFixture();
	caches.set("ready-auth-v2", JSON.stringify({ token: "stale-token" }));
	const original = fetch.mock.calls;
	const failure = mock.fn((url) => ({
		getResponseCode: () => (url.endsWith("login") ? HTTP_OK : HTTP_UNAUTHORIZED),
		getContentText: () => JSON.stringify({ token: "refreshed-token" }),
	}));
	context.UrlFetchApp.fetch = failure;
	const conference = context.onCreateReadyConference({ calendar: { calendarId: "primary", eventId: "event" } });
	assert.equal(failure.mock.callCount(), REFRESH_REQUEST_COUNT);
	assert.equal(original.length, 0);
	assert.equal(conference.error.fields.get("errorType"), "AUTHENTICATION");
	assert.equal(conference.error.fields.get("authenticationUrl"), "https://ready.app/docs/google-calendar-addon");
});

test("the deployable callback treats transport failure as temporary without modifying the event", () => {
	const { context, caches } = hostFixture();
	caches.set("ready-auth-v2", JSON.stringify({ token: "cached-token" }));
	const failure = mock.fn(() => {
		throw new Error(API_UNAVAILABLE_MESSAGE);
	});
	context.UrlFetchApp.fetch = failure;
	const conference = context.onCreateReadyConference({ calendar: { calendarId: "primary", eventId: "event" } });
	assert.equal(failure.mock.callCount(), 1);
	assert.equal(conference.error.fields.get("errorType"), "TEMPORARY");
	assert.equal(conference.id, undefined);
});
