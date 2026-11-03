# Ready (Google Calendar™ Workspace add-on)

Adds **Ready Meeting** to the video-conferencing dropdown in Google Calendar™.
Picking it creates a Ready meeting link via the public API and embeds the join
URL in the event. On first use, the add-on creates or reuses a free Ready
account from the user's verified Google identity. The sidebar confirms which
account is connected. No separate Ready signup or password is required. When
the user opens the Ready web app from the sidebar, Ready asks them to continue
with that same Google account and verifies the browser session before loading
the workspace.

For the current Marketplace resubmission values, use
`web/adapters/primary/google-calendar/marketplace-resubmission.md`.

## How auth works

No Google credentials are stored in Apps Script. On a cache miss the add-on mints a
Google OIDC identity token (`ScriptApp.getIdentityToken()`) and exchanges it at
`POST /v1/auth/google-addon-login`, which verifies the token against
`GOOGLE_ADDON_OAUTH_AUDIENCES`, resolves the stable Google subject before
email, creates or reuses the Ready account and default workspace, and returns
an app JWT (cached up to six hours in `CacheService`). If a cached Ready JWT is
rejected, the add-on silently exchanges the Google identity again and retries
the API request once.

Every signed-in account can create and host Ready meetings immediately. The
conference callback uses the Google Calendar and event IDs as an idempotency
key, so a Calendar retry reuses the already-created Ready link. It waits only
briefly for dial-in provisioning and returns a browser link even when phone
details need more time.

## Files

- `appsscript.json` — manifest: scopes, homepage trigger, and the
  `conferenceSolution` that registers "Ready Meeting" in the dropdown.
- `Code.js` — five synchronous Apps Script global wrappers (including editor diagnostics).
- `web/domain/google-calendar` — pure conference formatting, identity context, copy and JSON schemas.
- `web/ports/google-calendar.ts` — what the conference and homepage flows need from the host.
- `web/application/google-calendar` — injected authentication/retry and calendar flows.
- `web/adapters/secondary/apps-script` — Apps Script services behind the port.
- `web/adapters/primary/google-calendar` — Calendar conference data and CardService homepage.
- `web/composition/google-calendar` — wires the Apps Script host into the port.
- `web/scripts/build-google-calendar.mjs` — bundles the implementation and Zod as `dist/Implementation.js`,
  then copies the wrappers and unchanged manifest into `dist/`. No workspace imports
  remain at runtime. `.clasp.json` uses this directory and loads the bundle first.

Local validation from the repository root (no Google calls):

```sh
corepack pnpm --filter @readymeet/web test
corepack pnpm --filter @readymeet/web lint
```

The tests build and execute the actual deployment bundle and wrappers in a VM
with fake Apps Script services, as well as checking configuration and file equality.

## One-time Google setup

1. **GCP project** (standard, not the Apps Script default): note the project
   number. Enable the **Google Workspace Marketplace SDK** and
   **Apps Script API**.
2. **OAuth consent screen** (External): app name "Ready",
   support email,
   domain, privacy policy + terms URLs. Scopes used:
   `calendar.addons.execute`, `script.external_request`, `openid`,
   `userinfo.email`, `userinfo.profile`, and `calendar.events`. Keep these six
   scopes identical in Apps Script and the Marketplace SDK. Contacts and directory
   access belong to optional web integrations; they are not add-on permissions.
   Shared Cloud OAuth verification can cover both products' scope sets.
3. **Apps Script project**: create (clasp below), then in Project Settings →
   "Google Cloud Platform (GCP) Project" attach the project number from step 1.
4. **Script properties** (optional): `API_BASE_URL` / `WEB_BASE_URL` override
   the production defaults bundled from `web/adapters/secondary/apps-script/services.ts` (`https://api.ready.app` /
   `https://ready.app`). The API origin must stay within the manifest's
   `urlFetchWhitelist`.
5. **API env**: set `GOOGLE_ADDON_OAUTH_AUDIENCES` on the deployed API to the
   OAuth client id Google stamps as `aud` on the add-on's identity tokens
   (run `debugIdentityAudience` in the editor once to print it). The endpoint
   returns 503 until this is set.
6. The common add-on `logoUrl` (`https://ready.app/icon-128.png?v=2`) is
   served from `web/public/icon-128.png` (the day-31 brand mark,
   rasterized from `web/public/logos/days/31.svg`). Calendar conference
   chips use `calendar.conferenceSolution[].logoUrl`, and Google only renders
   that icon when the URL is hosted on Google's infrastructure. The manifest
   now uses the existing Marketplace 32x32 icon URL, verified in Calendar on
   September 24, 2026 (Apps Script version 18, existing Marketplace deployment).
   To replace it in the future, upload
   the Ready 32x32 icon in Google Cloud Console -> Google Workspace Marketplace
   SDK -> Store Listing -> Graphics Assets -> Application Icon 32x32, copy the
   generated image URL, and paste it into
   `appsscript.json` at `addOns.calendar.conferenceSolution[0].logoUrl`.
   Leaving the normal `ready.app` image URL there can make Calendar fall back
   to the generic video-camera icon even though the add-on still works.

## Deploy with clasp

Deploy migration `0072_google_addon_conference_idempotency.sql` and the API
before pushing this Apps Script version; the script calls the new idempotent
`POST /v1/meetings/google-calendar-addon` endpoint.

```sh
npm install -g @google/clasp   # or npx
clasp login                    # opens browser OAuth
cd web
node scripts/build-google-calendar.mjs --write
cd adapters/primary/google-calendar
clasp create --type standalone --title "Ready"
clasp push                     # uploads dist/{Implementation.js,Code.js,appsscript.json}
clasp deploy --description "v1"
```

## Authorization release checks

Follow the release order and fresh-install checks in `marketplace-resubmission.md`.
Opening Ready from the add-on requests identity only, with no offline integration
grant capture. The signed handoff still binds the browser session to the same
Google account. Web Calendar synchronization and contact/directory access require
a separate, explicit Connect action in ready.app. Existing connections remain
unchanged. Keep the standalone Marketplace listing and recording focused on
conferencing and saved-event descriptions, not optional web integrations.

## Test before publishing

Apps Script editor → Deploy → **Test deployments** → Install. The add-on then
works for your own account in Calendar (calendar.google.com → create event →
"Add video conferencing" dropdown → Ready Meeting). Use a Google account with
no existing Ready user to verify that the free account, owner workspace, and
first meeting are created in one flow. Re-select Ready Meeting for the same
event to verify that the existing link is reused. Domain users can be added as
testers without any Marketplace listing.

## Publish to the Marketplace

In the GCP console → Google Workspace Marketplace SDK:

1. **App configuration**: app type "Google Workspace add-on" with Apps Script, install scope
   (admin/individual), add the Apps Script **deployment ID**, list the same
   OAuth scopes as the manifest.
2. **Store listing**: name "Ready", descriptions from
   `marketplace-resubmission.md`, category, 128×128 + 32×32 icons, at least one
   1280×800 screenshot, support/privacy/terms URLs.
3. Visibility: **Public** requires Google review (app must be fully
   functional; provide a beta-enabled **test account** in the review notes so
   reviewers can exercise hosting). **Private** limits installs to your own
   Workspace domain.
4. Submit OAuth verification from the OAuth consent screen first; then submit
   the Marketplace listing after OAuth verification is approved.
5. OAuth brand verification + listing review typically take 1–3 weeks
   combined for a public listing.

## Saved-event description

The conference callback still returns the join button and phone entry immediately.
It also supplies its current Apps Script Calendar access token to the Ready API
for a durable, event-scoped description update. No additional OAuth scopes are
required. The API encrypts this short-lived credential; it is cleared when the
job finishes, is cancelled, or expires after 45 minutes. Revoked/expired grants
stop the update rather than selecting another connected Google account.

A separate API worker waits for the event and its matching Ready conference to
be saved. It adds a plain-text Ready meeting block containing the `Join meeting:` URL
and the `Dial-in: (US) … PIN: …#` line. Existing agenda text is preserved, and an
ETag precondition prevents stale writes. Duplicate delivery re-reads the event
and does not patch an already identical block. The worker waits up to ten minutes
for an active dial-in rule, then can publish the join link alone. Abandoned drafts
and unavailable credentials expire without indefinite retries. There are no AI
calls, no SIP creation retries, and no dependency on post-meeting processing.

Updates use `sendUpdates=none`: they do not request guest notification emails.
The first invitation email may have been sent before this update and is not
rewritten. Google and recipient clients control Calendar synchronization and
email rendering; verify those behaviors in a test calendar before release.

Deploy migration `0111_calendar_description_updates.sql` and the API before
publishing the updated Apps Script version. Older add-on versions continue to
create conferences without the description follow-up. This feature adds no
historical-event backfill.

Re-adding Ready to the same event renews the job and its 45-minute window, clears
attempts, and replaces the encrypted token. Old leases cannot finish the renewed
job. The add-on also supplies its configured web base URL, so conference matching
checks the meeting code on that origin instead of comparing against the API's web
URL. Other origins and meeting codes are rejected.

Each API process runs up to four independent description updates at once. Pending
attempts back off at 15, 30, 60, then 120 seconds until expiration, allowing saved
events to make progress alongside abandoned drafts. This queue does not use the
notes/tasks workers or call AI providers.
