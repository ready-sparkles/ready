-- One row per meeting while a request owns post-call finalization. The primary key makes the claim
-- atomic across API replicas; claimed_at lets a later request take over after a crashed run.
CREATE TABLE "meeting_finalization_claims" (
    "meeting_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_finalization_claims_pkey" PRIMARY KEY ("meeting_id")
);

ALTER TABLE "meeting_finalization_claims" ADD CONSTRAINT "meeting_finalization_claims_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
