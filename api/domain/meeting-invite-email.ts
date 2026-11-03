const FALLBACK_READY_LOGO_URL = "https://ready.app/icon-128.png?v=2";
const EMAIL_SUBJECT_PREFIX = "Happening now:";
const INVITE_INTRO_SUFFIX = "is inviting you to join a video call happening now.";
const MEETING_LABEL = "Meeting:";
const JOIN_CALL_LABEL = "Join call";
const DIAL_IN_LABEL = "Dial-in:";
const PIN_LABEL = "PIN:";
const FOOTER_COPY = "This invitation was sent from a live Ready meeting.";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildReadyLogoUrl(joinUrl: string): string {
  try {
    return new URL("/icon-128.png?v=2", joinUrl).toString();
  } catch (error) {
    void error;

    return FALLBACK_READY_LOGO_URL;
  }
}

type MeetingInviteEmailCallIn = {
  phoneNumber: string;
  pin: string;
};

const EMPTY_MEETING_TITLE_LINE_INDEX = 2;

export function buildMeetingInviteEmail(input: {
  inviterName: string;
  inviterEmail: string;
  meetingTitle: string;
  joinUrl: string;
  callIn?: MeetingInviteEmailCallIn | null;
}): { subject: string; html: string; text: string } {
  const trimmedInviterName = input.inviterName.trim();
  const inviterName = trimmedInviterName.length > 0 ? trimmedInviterName : input.inviterEmail;
  const subject = `${EMAIL_SUBJECT_PREFIX} ${inviterName} is inviting you to a video call`;
  const callInText =
    input.callIn !== null && input.callIn !== undefined
      ? `\n${DIAL_IN_LABEL} ${input.callIn.phoneNumber}\n${PIN_LABEL} ${input.callIn.pin}#`
      : "";
  const trimmedMeetingTitle = input.meetingTitle.trim();
  const text = [
    `${inviterName} <${input.inviterEmail}> ${INVITE_INTRO_SUFFIX}`,
    trimmedMeetingTitle.length > 0 ? `${MEETING_LABEL} ${trimmedMeetingTitle}` : "",
    "",
    `${JOIN_CALL_LABEL}: ${input.joinUrl}${callInText}`,
  ]
    .filter((line, index) => line.length > 0 || index === EMPTY_MEETING_TITLE_LINE_INDEX)
    .join("\n");

  const safeInviterName = escapeHtml(inviterName);
  const safeInviterEmail = escapeHtml(input.inviterEmail);
  const safeMeetingTitle = escapeHtml(trimmedMeetingTitle);
  const safeJoinUrl = escapeHtml(input.joinUrl);
  const safeLogoUrl = escapeHtml(buildReadyLogoUrl(input.joinUrl));
  const safeCallInNumber =
    input.callIn !== null && input.callIn !== undefined ? escapeHtml(input.callIn.phoneNumber) : "";
  const safeCallInPin = input.callIn !== null && input.callIn !== undefined ? escapeHtml(input.callIn.pin) : "";

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:16px;padding:40px;box-shadow:0 16px 48px rgba(12,18,28,0.08);">
            <tr>
              <td style="padding-bottom:26px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;padding-right:12px;">
                      <img src="${safeLogoUrl}" width="40" height="40" alt="Ready" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;border-radius:10px;">
                    </td>
                    <td style="vertical-align:middle;font-size:24px;font-weight:650;color:#111827;">Ready</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="font-size:17px;line-height:1.6;color:#242a33;padding-bottom:24px;">
                <strong>${safeInviterName}</strong> &lt;${safeInviterEmail}&gt; ${INVITE_INTRO_SUFFIX}
              </td>
            </tr>
            ${safeMeetingTitle.length > 0 ? `<tr><td style="font-size:14px;line-height:1.5;color:#68707d;padding-bottom:24px;">${safeMeetingTitle}</td></tr>` : ""}
            <tr>
              <td style="padding:34px 28px;background-color:#f7f7f8;border-radius:14px;text-align:center;">
                <a href="${safeJoinUrl}" style="display:inline-block;background-color:#6366f1;color:#ffffff;font-size:15px;font-weight:650;text-decoration:none;padding:13px 30px;border-radius:9999px;">${JOIN_CALL_LABEL}</a>
                <div style="font-size:14px;line-height:1.5;color:#4b5563;padding-top:22px;word-break:break-all;">${safeJoinUrl}</div>
                ${input.callIn !== null && input.callIn !== undefined ? `<div style="font-size:13px;line-height:1.6;color:#6b7280;padding-top:10px;">${DIAL_IN_LABEL} ${safeCallInNumber}<br>${PIN_LABEL} ${safeCallInPin}#</div>` : ""}
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;line-height:1.6;color:#8a919d;padding-top:22px;">${FOOTER_COPY}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
