import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCompanyDomain, resolveMemoryCompany } from "../../domain/memory-company";

void test("work emails produce a company label without exposing the address", () => {
  assert.deepEqual(resolveMemoryCompany({ emails: [" Personbd@Example.edu "] }), {
    companyName: "Example",
    companyDomain: "example.edu",
  });
  assert.deepEqual(resolveMemoryCompany({ emails: ["test-user@ready.app"] }), {
    companyName: "Ready",
    companyDomain: "ready.app",
  });
  assert.equal(memoryCompanyDomain("person@team.acme.co.uk"), "acme.co.uk");
  assert.equal(resolveMemoryCompany({ emails: ["person@acme-tools.com"] }).companyName, "Acme Tools");
});
const NON_COMPANY_EMAILS = [
  "x@gmail.com",
  "x@yahoo.co.uk",
  "x@pm.me",
  "x@fastmail.com",
  "x@privaterelay.appleid.com",
  "guest@guest.readymeet.local",
  "x@memory.test",
  "x@example.com",
  "x@co.uk",
  "x@localhost",
  "x@@ready.app",
  "not an email",
] as const;

void test("personal, relay, guest, reserved and invalid domains do not become companies", () => {
  NON_COMPANY_EMAILS.forEach((email) => {
    assert.equal(memoryCompanyDomain(email), null, email);
    assert.equal(resolveMemoryCompany({ emails: [email] }).companyName, null, email);
  });
});
void test("calendar research names must match the linked email domain", () => {
  assert.equal(
    resolveMemoryCompany({
      emails: ["x@example.edu"],
      companies: [{ name: "Example EDU", website: "https://www.example.edu" }],
    }).companyName,
    "Example EDU",
  );
  assert.equal(
    resolveMemoryCompany({
      emails: ["x@example.edu"],
      companies: [{ name: "Someone Else", website: "https://elsewhere.com" }],
    }).companyName,
    "Example",
  );
  assert.equal(
    resolveMemoryCompany({ emails: ["x@gmail.com"], companies: [{ name: "Google", website: "https://gmail.com" }] })
      .companyName,
    null,
  );
  assert.equal(resolveMemoryCompany({ emails: ["x@ready.app", "x@example.edu"] }).companyName, null);
  assert.equal(resolveMemoryCompany({ emails: ["x@ready.app", "x@gmail.com"] }).companyName, "Ready");
});
