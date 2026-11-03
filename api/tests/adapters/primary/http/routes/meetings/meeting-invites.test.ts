import assert from "node:assert/strict";
import test from "node:test";

import { sendMeetingInvitationBatch } from "../../../../../../adapters/primary/http/routes/meetings/meeting-invites";
import type { sendResendEmail } from "../../../../../../application/resend-client";

const INVITE_RECIPIENTS = ["first@example.com", "second@example.com", "third@example.com"];
const FAILED_RECIPIENT = "second@example.com";
const INVITATION_SUBJECT = "Join the call";
const INVITATION_BODY = "<p>Join the call</p>";
const TRANSPORT_ERROR_MESSAGE = "Unexpected transport failure";

void test("meeting invite batch reports unexpected send errors and continues with later recipients", async () => {
  const attempted = new Map<number, string>();
  const failures = new Map<string, { error: unknown; recipient: string }>();
  const onFailure: NonNullable<Parameters<typeof sendMeetingInvitationBatch>[0]["onFailure"]> = ({
    error,
    recipient,
  }) => {
    failures.set(recipient, { error, recipient });
  };

  const result = await sendMeetingInvitationBatch({
    recipients: INVITE_RECIPIENTS,
    message: {
      subject: INVITATION_SUBJECT,
      html: INVITATION_BODY,
      text: INVITATION_SUBJECT,
    },
    sendEmail: async ({ to }): Promise<Awaited<ReturnType<typeof sendResendEmail>>> => {
      attempted.set(attempted.size, to);
      if (to === FAILED_RECIPIENT) {
        throw new TypeError(TRANSPORT_ERROR_MESSAGE);
      }

      return {
        /** @external existing wire contract */
        sent: true,
        id: null,
      } satisfies Awaited<ReturnType<typeof sendResendEmail>>;
    },
    onFailure,
  });

  assert.deepEqual([...attempted.values()], INVITE_RECIPIENTS);
  assert.deepEqual(result, {
    sent: ["first@example.com", "third@example.com"],
    failures: [{ email: FAILED_RECIPIENT, reason: "send_failed" }],
  });
  assert.equal(failures.size, 1);
  const failure = failures.get(FAILED_RECIPIENT);
  assert.ok(failure);
  assert.equal(failure.recipient, FAILED_RECIPIENT);
  assert.ok(failure.error instanceof TypeError);
});
