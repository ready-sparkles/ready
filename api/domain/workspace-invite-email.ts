function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatExpiry(expiresAt: Date) {
  return expiresAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function buildReadyLogoUrl(acceptUrl: string) {
  try {
    return new URL("/icon-128.png?v=2", acceptUrl).toString();
  } catch (error) {
    if (error instanceof TypeError) {
      return "https://ready.app/icon-128.png?v=2";
    }
    throw error;
  }
}

export function buildWorkspaceInviteEmail(input: {
  inviterName: string;
  workspaceName: string;
  role: "admin" | "member";
  acceptUrl: string;
  expiresAt: Date;
}): { subject: string; html: string; text: string } {
  const roleLabel = input.role === "admin" ? "Admin" : "Member";
  const expiry = formatExpiry(input.expiresAt);
  const subject = `${input.inviterName} invited you to ${input.workspaceName} on Ready`;

  const text = [
    `${input.inviterName} invited you to join ${input.workspaceName} on Ready as ${roleLabel}.`,
    "",
    `Accept the invitation: ${input.acceptUrl}`,
    "",
    `This invitation expires on ${expiry}. If you weren't expecting it, you can ignore this email.`,
  ].join("\n");

  const inviter = escapeHtml(input.inviterName);
  const workspace = escapeHtml(input.workspaceName);
  const readyLogoUrl = escapeHtml(buildReadyLogoUrl(input.acceptUrl));
  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:16px;padding:40px;">
            <tr>
              <td style="padding-bottom:24px;">
                <img src="${readyLogoUrl}" width="40" height="40" alt="Ready" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;">
              </td>
            </tr>
            <tr>
              <td style="font-size:22px;font-weight:600;color:#111827;padding-bottom:12px;">
                Join ${workspace} on Ready
              </td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:1.6;color:#374151;padding-bottom:28px;">
                <strong>${inviter}</strong> invited you to join
                <strong>${workspace}</strong> as
                <strong>${roleLabel}</strong>.
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:28px;">
                <a href="${input.acceptUrl}"
                  style="display:inline-block;background-color:#6366f1;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:9999px;">
                  Accept invitation
                </a>
              </td>
            </tr>
            <tr>
              <td style="font-size:13px;line-height:1.6;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:20px;">
                This invitation expires on <strong>${escapeHtml(expiry)}</strong> and can only be
                accepted with this email address. If you weren't expecting it, you can safely
                ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
