import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mock, test } from "node:test";
import * as vm from "node:vm";
import { z } from "zod";

import { createAppsScriptServices } from "../../../../adapters/secondary/apps-script/services.ts";
import { createAuthFlow } from "../../../../application/google-calendar/auth.ts";
import { createCalendarFlow } from "../../../../application/google-calendar/calendar.ts";
import {
	AUTH_CACHE_KEY,
	conferenceContext,
	homepageCopy,
	readyWebSignInUrl,
} from "../../../../domain/google-calendar/conference.ts";
import { authSchema } from "../../../../domain/google-calendar/contracts.ts";

const INVALID_TOKEN = "Invalid token";
const READY_CODE = "ready-code";
const REFRESH_REQUEST_COUNT = 3;
const UNAVAILABLE = "Unavailable";
const AUTHORIZATION_REQUIRED = "authorization required";
const MEETING_PLAN_REQUIRED = "meeting_plan_required";
const MEETING_ACCESS_IS_REQUIRED_TO_CREATE_MORE_MEETING_ROOMS =
	"Meeting access is required to create more meeting rooms.";

const calendarRequestSchema = z
	.object({ calendarAccessToken: z.string(), calendarWebBaseUrl: z.string(), eventId: z.string() })
	.passthrough();
const HTTP_OK = 200,
	HTTP_UNAUTHORIZED = 401,
	HTTP_FORBIDDEN = 403,
	HTTP_INTERNAL_ERROR = 500,
	HTTP_UNAVAILABLE = 503;
function response({ status, body }) {
	return {
		getResponseCode() {
			return status;
		},
		getContentText() {
			return typeof body === "string" ? body : JSON.stringify(body ?? {});
		},
	};
}

function conferenceDataService() {
	return {
		ConferenceErrorType: {
			AUTHENTICATION: "AUTHENTICATION",
			TEMPORARY: "TEMPORARY",
		},
		newConferenceDataBuilder() {
			const conference = {};

			return {
				setConferenceSolutionId(conferenceSolutionId) {
					conference.conferenceSolutionId = conferenceSolutionId;

					return this;
				},
				setError(error) {
					conference.error = error;

					return this;
				},
				build() {
					return conference;
				},
			};
		},
		newConferenceError() {
			const error = {};

			return {
				setConferenceErrorType(errorType) {
					error.errorType = errorType;

					return this;
				},
				setAuthenticationUrl(authenticationUrl) {
					error.authenticationUrl = authenticationUrl;

					return this;
				},
				get errorType() {
					return error.errorType;
				},
				get authenticationUrl() {
					return error.authenticationUrl;
				},
			};
		},
	};
}

function loadAddon(overrides = {}) {
	const cacheValues = new Map();
	const cache = {
		get(key) {
			return cacheValues.get(key) ?? null;
		},
		put: mock.fn((key, value) => {
			cacheValues.set(key, value);
		}),
		remove(key) {
			cacheValues.delete(key);
		},
	};
	const context = {
		CacheService: { getUserCache: () => cache },
		PropertiesService: {
			getScriptProperties: () => ({ getProperty: () => null }),
		},
		ScriptApp: {
			AuthMode: { FULL: "FULL" },
			getIdentityToken: () => "google-id-token",
			getOAuthToken: () => "fixture-calendar-token",
			requireAllScopes() {},
		},
		UrlFetchApp: { fetch: () => response({ status: HTTP_INTERNAL_ERROR }) },
		ConferenceDataService: conferenceDataService(),
		Utilities: {},
		console: { error() {}, log() {}, info() {}, warn() {} },
		...overrides,
	};
	vm.createContext(context);
	vm.runInContext(
		fs.readFileSync(
			new URL("../../../../adapters/primary/google-calendar/dist/Implementation.js", import.meta.url),
			"utf8",
		),
		context,
	);
	vm.runInContext(
		fs.readFileSync(new URL("../../../../adapters/primary/google-calendar/dist/Code.js", import.meta.url), "utf8"),
		context,
		{
			filename: "Code.js",
		},
	);
	const services = createAppsScriptServices({
		script: context.ScriptApp,
		properties: context.PropertiesService,
		fetcher: context.UrlFetchApp,
		caches: context.CacheService,
		utilities: context.Utilities,
		logger: context.console,
	});
	const authFlow = createAuthFlow(services);
	const calendarFlow = createCalendarFlow({ port: services, authFlow });
	Object.assign(context, {
		AUTH_CACHE_KEY,
		readyApiRequest_: mock.fn((path, options) => authFlow.request({ path, options })),
		getReadyAuthResult_: authFlow.getAuthResult,
		webBaseUrl_: services.webBaseUrl,
		conferenceContext_: conferenceContext,
		homepageCopy_: mock.fn((auth, isAccountCreated) =>
			homepageCopy({ auth, isAccountCreated, webBaseUrl: services.webBaseUrl() }),
		),
		consumeAccountCreated_: calendarFlow.consumeAccountCreated,
		readyWebSignInUrl_: (auth) => readyWebSignInUrl({ auth, webBaseUrl: services.webBaseUrl() }),
	});

	return { context, cache, cacheValues };
}

test("an expired cached Ready JWT is refreshed and the API call is retried once", () => {
	/** @fixtureCapture host call observation */
	const calls = [];
	const { context, cache } = loadAddon({
		UrlFetchApp: {
			fetch: mock.fn((url, options) => {
				calls.push({ url, options });
				if (url.endsWith("/v1/auth/google-addon-login")) {
					return response({
						status: HTTP_OK,
						body: {
							token: "fresh-token",
							/** @external Host/Ready wire field */
							accountCreated: false,
							webHandoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
							webHandoffToken: "header.payload.signature",
							user: { email: "person@example.com" },
						},
					});
				}
				if (options.headers.Authorization === "Bearer stale-token") {
					return response({ status: HTTP_UNAUTHORIZED, body: { message: INVALID_TOKEN } });
				}

				return response({ status: HTTP_OK, body: { meetingLink: { code: READY_CODE } } });
			}),
		},
	});
	cache.put(
		context.AUTH_CACHE_KEY,
		JSON.stringify({
			token: "stale-token",
			/** @external Host/Ready wire field */
			accountCreated: false,
			user: { email: "person@example.com" },
		}),
	);

	const result = context.readyApiRequest_("/v1/meetings/google-calendar-addon", {
		method: "post",
		payload: { title: "Ready meeting", calendarId: "calendar", eventId: "event" },
	});

	assert.equal(result.response.status, HTTP_OK);
	assert.equal(result.auth.token, "fresh-token");
	assert.equal(calls.length, REFRESH_REQUEST_COUNT);
	assert.equal(calls[2].options.headers.Authorization, "Bearer fresh-token");
});

test("temporary auth failures do not send users to a Ready browser login", () => {
	const { context } = loadAddon({
		UrlFetchApp: { fetch: () => response({ status: HTTP_UNAVAILABLE, body: { message: UNAVAILABLE } }) },
	});
	const result = context.getReadyAuthResult_(false);
	assert.equal(result.auth, null);
	assert.equal(result.errorType, "temporary");
	assert.equal(`${context.webBaseUrl_()}/docs/google-calendar-addon`, "https://ready.app/docs/google-calendar-addon");
});

test("conference identity supports the Calendar callback event shape", () => {
	const { context } = loadAddon();
	const identity = context.conferenceContext_({
		calendar: {
			calendarId: "owner@example.com",
			id: "event_123",
		},
	});
	assert.deepEqual(identity, { calendarId: "owner@example.com", eventId: "event_123" });
	assert.equal(context.conferenceContext_({ calendar: { calendarId: "missing-event" } }), null);
});

test("conference creation requires every declared OAuth scope before API work", () => {
	const authorizationRequired = new Error(AUTHORIZATION_REQUIRED);
	const fetchCalls = new Set();
	const { context } = loadAddon({
		ScriptApp: {
			AuthMode: { FULL: "FULL" },
			getIdentityToken: () => "google-id-token",
			getOAuthToken: () => "fixture-calendar-token",
			requireAllScopes(authMode) {
				assert.equal(authMode, "FULL");
				throw authorizationRequired;
			},
		},
		UrlFetchApp: {
			fetch() {
				fetchCalls.add("called");

				return response({ status: HTTP_INTERNAL_ERROR });
			},
		},
	});

	assert.throws(
		() =>
			context.onCreateReadyConference({
				calendar: { calendarId: "owner@example.com", id: "event_123" },
			}),
		authorizationRequired,
	);
	assert.equal(fetchCalls.size, 0);
});

test("meeting access failures use Calendar authentication recovery instead of a temporary error", () => {
	const { context, cache } = loadAddon({
		UrlFetchApp: {
			fetch: () =>
				response({
					status: HTTP_FORBIDDEN,
					body: {
						code: MEETING_PLAN_REQUIRED,
						message: MEETING_ACCESS_IS_REQUIRED_TO_CREATE_MORE_MEETING_ROOMS,
					},
				}),
		},
	});
	cache.put(
		context.AUTH_CACHE_KEY,
		JSON.stringify({
			token: "ready-token",
			/** @external Host/Ready wire field */
			accountCreated: false,
			user: { email: "person@example.com" },
		}),
	);

	const conference = context.onCreateReadyConference({
		calendar: {
			calendarId: "owner@example.com",
			eventId: "event_123",
		},
	});

	assert.equal(conference.error.errorType, "AUTHENTICATION");
	assert.equal(conference.error.authenticationUrl, "https://ready.app/docs/google-calendar-addon");
});

test("homepage copy describes immediate free-account access without waitlist language", () => {
	const { context, cache } = loadAddon();
	const auth = {
		token: "ready-token",
		/** @external Host/Ready wire field */
		accountCreated: true,
		webHandoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
		webHandoffToken: "header.payload.signature",
		user: { id: "94e9d223-9361-49e4-925e-8756e2116084", email: "person@example.com" },
	};
	const copy = homepageCopy({
		auth,
		isAccountCreated: context.consumeAccountCreated_(auth),
		webBaseUrl: context.webBaseUrl_(),
	});
	assert.equal(copy.title, "Your free Ready account is ready");
	assert.match(copy.body, /Meetings work immediately on the free plan/);
	assert.doesNotMatch(copy.body, /waitlist|private beta/i);
	assert.equal(authSchema.parse(JSON.parse(cache.get(context.AUTH_CACHE_KEY))).accountCreated, false);
});

test("Open Ready sends the connected account through the dedicated Google browser sign-in", () => {
	const { context } = loadAddon();
	const url = context.readyWebSignInUrl_({
		token: "ready-token",
		webHandoffId: "86f3cce4-556d-4a8c-9897-d3f806eac0ac",
		webHandoffToken: "header.payload.signature",
		user: {
			id: "94e9d223-9361-49e4-925e-8756e2116084",
			email: "reviewer+ready@example.com",
		},
	});

	assert.equal(
		url,
		"https://ready.app/login?source=google-workspace-addon&accountId=94e9d223-9361-49e4-925e-8756e2116084&loginHint=reviewer%2Bready%40example.com&handoffId=86f3cce4-556d-4a8c-9897-d3f806eac0ac&handoffToken=header.payload.signature&callbackUrl=%2Fworkspace",
	);
	assert.equal(context.readyWebSignInUrl_({ token: "ready-token", user: {} }), null);
});

test("Open Ready requires a signed browser handoff from the API", () => {
	const { context } = loadAddon();
	assert.equal(
		context.readyWebSignInUrl_({
			token: "ready-token",
			user: {
				id: "94e9d223-9361-49e4-925e-8756e2116084",
				email: "reviewer+ready@example.com",
			},
		}),
		null,
	);
});

test("conference callback sends the short-lived Calendar grant only to the Ready API", () => {
	const received = new Map();
	const { context, cache } = loadAddon({
		UrlFetchApp: {
			fetch: mock.fn((url, request) => {
				assert.equal(url, "https://api.ready.app/v1/meetings/google-calendar-addon");
				received.set("payload", calendarRequestSchema.parse(JSON.parse(request.payload)));

				return response({ status: HTTP_UNAVAILABLE });
			}),
		},
	});
	cache.put(context.AUTH_CACHE_KEY, JSON.stringify({ token: "fixture-ready-token" }));
	context.onCreateReadyConference({ calendar: { calendarId: "primary", eventId: "fixture-event" } });
	assert.equal(received.get("payload").calendarAccessToken, "fixture-calendar-token");
	assert.equal(received.get("payload").calendarWebBaseUrl, "https://ready.app");
	assert.equal(received.get("payload").eventId, "fixture-event");
});
