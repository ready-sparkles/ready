# Draft question for Google Marketplace review

This is a prepared draft, not a sent message or a resubmission claim.

Hello,

We have aligned Ready's Apps Script manifest, deployed version, Marketplace SDK,
OAuth Data Access configuration, and first web authorization request to the same
eight canonical scopes. The Apps Script, Marketplace integration and web OAuth
clients belong to the same Cloud project. OAuth verification is approved.

We reproduced the remaining authorization issue with an individual Workspace
test account after revoking the previous Ready grant, uninstalling the add-on,
waiting more than 15 minutes and reinstalling in a single-account private window:

1. Installation grants the eight permissions once and succeeds.
2. The Calendar add-on opens and recognizes the correct Google account.
3. Open Ready starts server-side Google OAuth using the same eight scopes,
   `access_type=offline` and `include_granted_scopes=true`, without forced consent.
4. Google account selection returns directly to Ready without another permissions
   screen. The server-side code exchange supplies an access token with all eight
   scopes, but no refresh token.
5. Ready's web Calendar integration requires renewable authorization for
   background synchronization and user-requested Calendar operations after the
   short-lived access token expires. Requesting offline recovery consent would
   display the additional permission screen described in the rejection.

What is Google's supported way to obtain renewable backend Calendar access from
an individual Apps Script Marketplace installation without a second consent
screen? Is there a Marketplace or OAuth client setting needed for this flow, or
a supported bridge to Apps Script's managed authorization?

We understand that Apps Script exposes an expiring access token and that
administrator-installed domain-wide delegation is a separate installation model.
We need to preserve individual installation and existing web Calendar behavior.
Please advise the supported individual-install implementation or the approved
review flow for establishing offline authorization.

We have not marked the no-second-consent requirement resolved or resubmitted the
listing. We can provide a new recording and sanitized request parameters.

Thank you.
