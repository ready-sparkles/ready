# Ready Google Calendar™ Marketplace resubmission

Use these values when resubmitting the Google Workspace™ Marketplace listing and OAuth consent screen.

## App details

Application name:

Ready

Short description:

Add Ready meeting links and dial-in details to Google Calendar™ events.

Detailed description:

Ready brings your meetings to Google Calendar™. Add a Ready Meeting from the native video-conferencing menu and give guests a browser join link, plus a phone number and PIN when dial-in is available.

Key Features

- Create or edit an event and choose Ready Meeting directly in Google Calendar™.
- Add a Ready browser join link and available dial-in details to the event's conferencing section.
- After saving the event, Ready adds the join link and available phone number and PIN to its description while preserving your existing agenda.
- Re-select Ready for the same event to reuse its meeting link.
- Open Ready from the Calendar sidebar and continue with the same Google account.
- Install individually or through your Google Workspace™ administrator.

The add-on creates or reuses your Ready account from your verified Google identity. No separate Ready signup, password, or web Calendar connection is required to add conferencing to an event.

Meeting descriptions update shortly after saving. This update does not request an additional invitation email; the original invitation may be sent before the description is updated.

Ready's web app offers additional meeting and AI features. Optional web integrations are connected separately in ready.app and are not required to use this Calendar add-on. Meeting hosting is available on the free plan; additional features may require credits or a paid plan.

Google Calendar™ and Google Workspace™ are trademarks of Google LLC.

## OAuth scopes

The standalone add-on requests six scopes. Keep the Apps Script manifest and
Marketplace SDK aligned with `GOOGLE_WORKSPACE_ADDON_SCOPES`:

- `calendar.addons.execute`: run the Calendar add-on.
- `script.external_request`: call Ready's API.
- `openid`, `userinfo.email`, `userinfo.profile`: identify the user and create or reuse their Ready account.
- `calendar.events`: update saved event descriptions using the short-lived add-on grant.

Contacts and Workspace directory scopes are excluded. Opening ready.app uses
identity-only Google sign-in and does not import integration credentials. Users
can separately choose Connect Calendar in the web app to authorize background
sync, event management, contacts, and directory features. Existing web connections
remain intact. The shared Cloud project's OAuth verification may still include
web-only scopes; do not remove those from the web integration's configuration.
Leave Setup URL and Admin Config URL empty: the standalone add-on requires no
additional setup after installation.

Keep project IDs, deployment identifiers, verification evidence, and release status in a private operational runbook.

## Standalone release checks

1. Deploy identity-only web sign-in, then the six-scope Apps Script manifest.
2. Update the existing Marketplace deployment and remove contacts/directory from
   the SDK scope list. Keep shared web OAuth verification unchanged.
3. Install as a draft tester. Verify the consent screen excludes contacts and
   directory access. Reinstall does not prove old grants were revoked.
4. Without opening ready.app or connecting Calendar there, create a Calendar
   event, choose Ready Meeting, save it, and verify its join link, available
   dial-in details, and description. Check that the agenda is preserved.
5. Re-select Ready for the same event and verify it reuses the link without
   duplicating the description block.
6. Check Open Ready signs into the correct account with identity permissions
   only and does not create a Calendar connection. Separately test an explicit
   web Calendar connection; this is outside the standalone add-on demo.
7. Repeat standalone installation as an administrator-installed domain user.
   Record which checks passed; do not claim unperformed checks passed.
8. Record the standalone install/create/save/result flow before resubmitting.

## Graphics

Upload workflow screenshots from `web/adapters/primary/google-calendar/marketplace-assets`:

- `ready-marketplace-screenshot-sidebar-1280x800.png`

The generic overview remains available as `ready-marketplace-screenshot-1280x800.png`. Capture a new result screenshot with fictional names and non-working meeting details before submission; the older result images were removed because they contained identifying details.

## Review notes

Describe only completed live checks. The add-on installs with six scopes and
works independently of ready.app's optional Calendar/contacts integrations.
The demo should show install, create event, choose Ready Meeting, save, and the
resulting conference and description. Do not claim fresh-install or administrator
installation passed until verified. Do not submit until the recording is ready.
