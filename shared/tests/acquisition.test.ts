import assert from "node:assert/strict";
import { test } from "node:test";

import { acquisitionFromLanding, parseAcquisitionCookie } from "../domain/acquisition";

void test("campaign survives signup navigation, OAuth return, and a later direct visit", () => {
  const ad = acquisitionFromLanding(
    "https://ready.app/?utm_source=google&utm_medium=cpc&utm_campaign=search_us&utm_term=zoom+alternative&gclid=click_1&campaign_id=123",
    "https://google.com/",
  );
  const login = acquisitionFromLanding("https://ready.app/login", "https://ready.app/", ad);
  const returned = acquisitionFromLanding(
    "https://ready.app/workspace?secret=never-save",
    "https://accounts.google.com/",
    login,
  );
  assert.deepEqual(returned.first, ad.first);
  assert.deepEqual(returned.last, ad.last);
  assert.equal(returned.last.keyword, "zoom alternative");
  assert.equal(JSON.stringify(returned).includes("secret"), false);
  assert.deepEqual(parseAcquisitionCookie(encodeURIComponent(JSON.stringify(returned))), returned);
});
void test("later paid campaign updates last touch without overwriting original acquisition", () => {
  const original = acquisitionFromLanding("https://ready.app/?utm_source=google&utm_campaign=first", "");
  const later = acquisitionFromLanding("https://ready.app/?utm_source=google&utm_campaign=second", "", original);
  assert.equal(later.first.campaign, "first");
  assert.equal(later.last.campaign, "second");
});
void test("untrusted attribution is bounded and excludes arbitrary URL fields and email values", () => {
  const result = acquisitionFromLanding(
    "https://ready.app/?utm_source=person@example.com&email=person@example.com&gclid=%3Cscript%3E&campaign_id=nope",
    "",
  );
  assert.equal(result.last.source, "unknown");
  assert.equal(result.last.gclid, undefined);
  assert.equal(result.last.campaignId, undefined);
  assert.equal(JSON.stringify(result).includes("@"), false);
  assert.equal(parseAcquisitionCookie("%bad"), undefined);
  const old = acquisitionFromLanding("https://ready.app", "", undefined, new Date("2020-01-01"));
  assert.equal(parseAcquisitionCookie(encodeURIComponent(JSON.stringify(old))), undefined);
});

void test("recognizes search and social referrals without trusting lookalike domains", () => {
  const referrals = [
    ["www.google.com", "google", "organic"],
    ["www.google.co.uk", "google", "organic"],
    ["www.bing.com", "bing", "organic"],
    ["duckduckgo.com", "duckduckgo", "organic"],
    ["search.yahoo.com", "yahoo", "organic"],
    ["www.linkedin.com", "linkedin", "social"],
    ["l.facebook.com", "facebook", "social"],
    ["t.co", "twitter", "social"],
    ["www.reddit.com", "reddit", "social"],
    ["chatgpt.com", "chatgpt.com", "referral"],
    ["evilgoogle.com", "evilgoogle.com", "referral"],
    ["google.com.evil.com", "google.com.evil.com", "referral"],
  ] as const;
  referrals.forEach(([host, source, medium]) => {
    const { last } = acquisitionFromLanding("https://ready.app", `https://${host}/private?query=secret`);
    assert.equal(last.source, source, host);
    assert.equal(last.medium, medium, host);
    assert.equal(JSON.stringify(last).includes("secret"), false);
  });
});

void test("explicit campaigns override inferred referrals and only valid click IDs imply paid search", () => {
  const tagged = acquisitionFromLanding(
    "https://ready.app/?utm_source=newsletter&utm_medium=email",
    "https://google.com",
  );
  assert.equal(tagged.last.source, "newsletter");
  assert.equal(tagged.last.medium, "email");
  const paid = acquisitionFromLanding("https://ready.app/?gclid=valid_click", "https://google.com");
  assert.equal(paid.last.medium, "cpc");
  const invalid = acquisitionFromLanding("https://ready.app/?gclid=%3Cinvalid%3E", "https://google.com");
  assert.equal(invalid.last.medium, "organic");
});

void test("new external arrivals update last touch while internal, OAuth, and direct visits preserve it", () => {
  const original = acquisitionFromLanding("https://ready.app", "https://google.com");
  const social = acquisitionFromLanding("https://ready.app", "https://linkedin.com", original);
  assert.deepEqual(social.first, original.first);
  assert.equal(social.last.source, "linkedin");
  [
    "",
    "https://ready.app",
    "https://www.ready.new",
    "https://accounts.google.com",
    "https://login.microsoftonline.com",
    "https://login.live.com",
  ].forEach((referrer) => {
    assert.deepEqual(acquisitionFromLanding("https://ready.app/workspace", referrer, social).last, social.last);
    assert.equal(acquisitionFromLanding("https://ready.app/workspace", referrer).last.source, "direct");
  });
});
