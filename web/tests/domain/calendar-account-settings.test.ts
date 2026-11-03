import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarAccountStatusCopy,
  isCurrentProviderAccountLoad,
  providerAccountsForUser,
} from "../../domain/calendar-account-settings";

const CURRENT_REQUEST_ID = 2;

void test("provider account loads only apply to the current user, token, and request", () => {
  const current = {
    requestId: CURRENT_REQUEST_ID,
    token: "token-personbr",
    userId: "user-personbr",
  };

  assert.equal(isCurrentProviderAccountLoad({ request: current, current }), true);
  assert.equal(isCurrentProviderAccountLoad({ request: { ...current, requestId: 1 }, current }), false);
  assert.equal(isCurrentProviderAccountLoad({ request: { ...current, token: "token-samz" }, current }), false);
  assert.equal(isCurrentProviderAccountLoad({ request: { ...current, userId: "user-samz" }, current }), false);
  assert.equal(isCurrentProviderAccountLoad({ request: current, current: null }), false);
});

void test("provider accounts are filtered to the authenticated Ready user", () => {
  const accounts = [
    { id: "calendar-personbr", userId: "user-personbr" },
    { id: "calendar-samz", userId: "user-samz" },
  ];

  assert.deepEqual(providerAccountsForUser({ accounts, userId: "user-personbr" }), [
    { id: "calendar-personbr", userId: "user-personbr" },
  ]);
});

void test("calendar status copy does not make unusable accounts look connected", () => {
  assert.equal(calendarAccountStatusCopy("connected"), "Connected");
  assert.equal(calendarAccountStatusCopy("disconnected"), "Disconnected — reconnect to show events");
  assert.equal(calendarAccountStatusCopy("error"), "Connection problem — reconnect to show events");
});
