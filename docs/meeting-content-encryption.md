# Meeting content encryption

## Scope and deployment

The application code encrypts protected database writes and decrypts authorized reads.
Infrastructure provisioning, runtime configuration, and existing-content migration
are separate deployment steps. Verify their status in your private operational
runbook before making claims about a running deployment.

The target is transcripts, summaries, notes, chat, task titles/descriptions,
meeting titles/agendas, evidence, derived JSON, and saved copies. Account names,
emails, sign-in, connected integrations, IDs, timestamps, statuses, and links stay
unchanged. Authorized backends decrypt in memory for users and AI providers. This
is not end-to-end encryption or protection against a compromised authorized backend.

## Cryptography and key custody

- `db/adapters/secondary/postgres/content-encryption.ts`: local AES-256-GCM envelope
  encryption. A wrapping key from `MEETING_CONTENT_WRAPPING_KEY` wraps a fresh data
  key per changed record write. Field nonces are independent. Envelopes are versioned
  and store the wrapped key.
- Associated data authenticates application, purpose, model, and opaque record ID.
  AES-GCM additionally authenticates the field name. A copied field cannot be
  decrypted under a different identity. Primary keys come from the database, not
  from an untrusted envelope. Never place readable text in encryption context.
- No plaintext legacy read or cross-operation data-key cache. `NODE_ENV=development`
  with both key env vars empty uses a local-only provider and logs that choice. The
  provider is refused for every other `NODE_ENV`, including production. Local
  key/buffer contents are zeroed on success/failure. Runtime copies, JavaScript
  strings, OS swap and dumps cannot be reliably erased here.
- SQL NULL stays SQL NULL. Whole JSON values retain ordinary JSON serialization
  semantics, including omitted undefined object properties and null array holes.
  Protected JSON defaults are encrypted in the application; database defaults are
  removed to prevent implicit unencrypted copies.
- Errors from cryptographic operations have constant safe messages. Provider error
  text is not attached as a cause. Account authentication secrets retain their
  existing encryption/configuration; they are not re-keyed by this feature.

### Approved keyed lookup fingerprints

The user approved this additional pattern. A dedicated stable HMAC key from
`MEETING_CONTENT_LOOKUP_KEY` produces `HMAC-SHA-256` over a domain-separated
SHA-256 digest. The original text stays encrypted. Neither raw readable values nor
secret MAC keys are stored in the lookup columns. Fingerprints disclose equality
and are not anonymous identifiers.

- Task-section `titleFingerprint` preserves active title uniqueness within each workspace.
- Ambient `canonicalKeyFingerprint` preserves per-meeting entity uniqueness.
- Research `queryKeyFingerprint` preserves active-query uniqueness/cancellation.
- Research `queryFingerprint` preserves the prior query-text equality fallback.
- Ambient `errorFingerprint` preserves the existing retry check for the known
  identity-verification error without leaving arbitrary error text readable.

Set both `MEETING_CONTENT_WRAPPING_KEY` and `MEETING_CONTENT_LOOKUP_KEY` on
authorized backend services. Each value is a 32-byte key encoded as 64 hex
characters. Production startup fails closed when either value is missing or
invalid. The wrapping key can be rotated only with a re-encrypt plan; the HMAC
key must remain stable. Replacing it requires an explicit transactional
fingerprint-rebuild plan. Records encrypted with the retired AWS KMS keys cannot
be decrypted after those keys are deleted.

## Persistence inventory

Authoritative schema: `db/prisma/schema.prisma`. This checkout uses Prisma; the
planning transcript's older Drizzle schema paths are not current.

Encrypt whole content JSON values, not a selection of known nested keys:

| Models                                                                                      | Protected fields                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meetings`, `meetingLinks`                                                                  | `title`                                                                                                                                                                                 |
| `transcriptSegments`, `summaries`, `agentMemories`                                          | `content`                                                                                                                                                                               |
| `transcripts`                                                                               | `metadata` (accepts arbitrary content)                                                                                                                                                  |
| `actionItems`                                                                               | `text`                                                                                                                                                                                  |
| `meetingTasks`                                                                              | `title`, `description`, `dueDateValue`, `sourceQuotes`, `sourceReason`, `externalLinks`                                                                                                 |
| `workspaceTasks`, `workspaceTaskSections`                                                   | Task `title`, `description`, `dueDateValue`; section `title`                                                                                                                            |
| `meetingLiveTaskCandidates`                                                                 | `title`, `description`, `dueDateValue`, `completion`, `sourceQuotes`, `sourceReason`, `unresolvedQuestions`                                                                             |
| `meetingLiveTaskCandidateEvidence`                                                          | `fullSegmentText`, `quote`                                                                                                                                                              |
| `meetingAssets`                                                                             | `transcriptExcerpt`                                                                                                                                                                     |
| `meetingExtractions`                                                                        | `meetingTypeReasoning`, `participants`, `summaryShort`, `summaryBullets`, `decisions`, `actionItems`, `openQuestions`, `risks`, `keyTopics`, `signals`, `failedToolCalls`, `highlights` |
| `meetingCapabilityRecommendations`                                                          | `signalsMatched`, `signalsMissing`, `exclusionSignalsChecked`, `reasoning`, `payload`                                                                                                   |
| `capabilityWorkflowRuns`                                                                    | `context`, `plan`, `draft`, `result`, `error`                                                                                                                                           |
| `capabilityWorkflowMessages`                                                                | `content`, `metadata`                                                                                                                                                                   |
| `aiWorkflowExecutions`                                                                      | `payload`, `result`, `error`                                                                                                                                                            |
| `agentToolInvocations`                                                                      | `redactedArgs`, `redactedResultSummary` (despite their names, these retain content)                                                                                                     |
| `linearTaskReviewRuns`                                                                      | `inputSnapshot`, `error`                                                                                                                                                                |
| `linearTaskReviewItems`                                                                     | `reasoning`, `title`, `description`, `syncError`, `externalIssueTitle`, `externalIssueUrl`, `issueDraft`, `duplicateIssues`, `targetIssue`                                              |
| `meetingResearchRuns`                                                                       | `query`, `progressLabel`, `progressDetail`, `runRefs`, `result`, `error`                                                                                                                |
| `voiceWebResearchRuns`                                                                      | `query`, `queryKey`, `runRefs`, `progress`, `result`, `error`                                                                                                                           |
| `calendarEventPreps`                                                                        | `runRefs`, `eventSnapshot`, `result`, `error`                                                                                                                                           |
| `meetingAmbientContextItems`                                                                | `canonicalKey`, `displayName`, `qualifier`, `professionalTitle`, `companyName`, `headquarters`, `officialWebsite`, `profileUrl`, `summary`, `facts`, `citations`, `facets`, `error`     |
| `meetingSuggestedActionRuns`                                                                | `steps`, `message`, `error`                                                                                                                                                             |
| `meetingTaskLists`                                                                          | `error`                                                                                                                                                                                 |
| `meetingTrackers`                                                                           | `items`                                                                                                                                                                                 |
| `ashbyReviews`, `ashbyMeetingAnalyses`, `ashbyReviewActions`                                | Review `review`/`command`; analysis/action `result`                                                                                                                                     |
| `slackMeetingReviews`                                                                       | `review`                                                                                                                                                                                |
| `relationshipMemories`                                                                      | `title`, `description`, `factIdentity`, content-bearing `candidateSubjectKey`                                                                                                           |
| `memoryEvidence`, `memoryPersonProjections`, `memorySuppressions`, `memoryGenerationLedger` | `quote`, `content`, `factIdentity`, `error`, respectively                                                                                                                               |

Account identity fields are excluded. Names inside protected content remain encrypted.
`agentProfiles.systemPrompt`, connector configuration, billing/usage/audit metadata,
and static capability catalog configuration are outside this meeting-content field
allowlist; do not put meeting content in those operational stores. New fields and raw
SQL paths require an explicit protection review. Existing unkeyed transcript/fact/input
hashes and object hashes leak equality and may permit guessing; this is not anonymity.

## Integration coverage

`content-client.ts` wraps the shared Prisma client and callback transactions.
It handles reads, select/include relations, creates (including nested creates),
bulk creates, per-row bulk updates, upserts, and returned/deleted records. Protected
writes lock their real rows before encoding. No-op plaintext updates retain
identical ciphertext, preserving transcript-memory invalidation behavior.

Existing application paths use these operations. Unsupported content predicates,
protected sort/group operations, primary-key rewrites, nested update recipes, and
array-form transactions fail closed rather than silently bypass encryption. Use
callback transactions and explicit repository operations. There is no general
transparent encrypted SQL engine.

Raw SQL remains explicit: table-aware `insertRaw` encoding and returned-row decoding;
record-bound invocation transitions; explicit projections for calendar mappings,
meeting lists, past context, assigned tasks, admin lists and locked memory pruning.
Ashby/Slack/evidence/suppression inserts use model operations. The transcript
precision shim runs within its locked transaction using already-encrypted content.
Memory revision calculations decrypt before hashing and preserve microseconds.
Title compare-and-swap locks the meeting, checks decrypted title, and retains job
expiry/row-lock checks. Installed plaintext JSON/revision SQL functions are retired.

### Files, logs and browser storage

- Screenshots and ambient images are encrypted before local/object-store writes.
  `meeting-content-objects.ts` reuses the same envelope boundary, authenticating
  the opaque storage key. The API decrypts only after its existing authorization
  check. Image responses use `Cache-Control: no-store`. Old image bytes have no
  plaintext compatibility fallback and must be removed during cutover.
- Meeting-agent debug logging keeps event names only; it no longer appends payloads
  to stdout or its debug file. API error serializers omit messages/stacks/causes;
  known content bindings are redacted. Assistant extraction/selection logging
  omits provider errors and raw input. Realtime error fields/exception traces are
  redacted. This does not prove that third-party host/provider logs contain no
  private information; review their retention independently.
- React Query is memory-only. Old idb-keyval query caches are cleared on mount,
  including guest views. Old meeting-detail/preparation/toast sessionStorage values
  are removed and never restored or rewritten. Authorized pages fetch fresh data
  after reload; already loaded in-memory data still works during a temporary outage.
  Browser caches cannot be remotely purged for users who never reopen the app.

## Runtime keys and cutover gates

Generate two independent 32-byte keys (`openssl rand -hex 32`) and set them as
`MEETING_CONTENT_WRAPPING_KEY` and `MEETING_CONTENT_LOOKUP_KEY` on the API and
assistant. Keep them out of source control. The HMAC key must remain stable while
fingerprinted records exist.

Records encrypted with the retired AWS KMS wrapping key become unreadable once
that key is deleted. Their lookup fingerprints also stop matching. There is no
compatibility decrypt path for KMS envelopes.

Before application deployment:

1. Confirm the API/assistant environment variables; deploy only with explicit
   production deployment authorization. The application must remain fail-closed
   if either key is missing.
2. Preserve existing content using the maintenance command below only when you
   still have a key that can decrypt the current rows. **Ordinary migration 0137
   still refuses nonempty protected tables.** The explicitly invoked maintenance
   path encrypts existing records; it never deletes them. Do not
   `TRUNCATE ... CASCADE` or bypass the migration guard manually.
3. Retain original images and a database backup for recovery. Old plaintext image
   copies, disk logs, log drains, backups/WAL/snapshots and external provider copies
   need a separate retention decision; this conversion does not erase them. A
   previously failed Prisma migration must be reviewed/resolved before maintenance.
4. Deploy compatible encrypted readers/writers together. Failures must not persist
   plaintext. Do not roll back to old plaintext writers against encrypted rows.
   Scan raw rows/dumps and object bytes using sentinel content, then exercise notes,
   transcription, tasks, exports, AI, integrations, memory and authorized image reads.
5. Keep the wrapping and lookup keys for the lifetime of retained ciphertext.
   Deleting either key makes matching records unrecoverable.

## Existing-content maintenance command

Use compatible encryption code. Confirm a usable database backup, pause
auto-deploy, and stop API, assistant,
meeting-agent, realtime, and scheduled writers. No old readers/writers may run
against a partially converted database. Do not stop Postgres itself.

Run from the repository with the production API environment, including database,
object storage and the content keys. Never print that environment:

```sh
NODE_ENV=production corepack pnpm --filter @readymeet/api maintenance:encrypt-content \
  --writers-stopped --backup-confirmed
```

The command acquires the ordinary migration lock, adopts existing migration history,
then applies missing prerequisites and migration 0137 in a single database transaction.
It widens content fields, encrypts the current allowlist, fills keyed fingerprints,
verifies persisted values by decryption, and adds the final constraints/indexes.
It preserves identity, operational fields and timestamp precision. Known content
triggers are suppressed transactionally so conversion does not invalidate memories,
allocate trial slots, or create synchronization events. Foreign keys stay enabled.
Only successful conversion records the exact 0137 checksum as applied.

Meeting and ambient images are copied to `<original-key>.ready-content-v1`, encrypted
with that new key as their authenticated identity, and verified before their database
references change. Originals are never deleted. Missing source images fail the command.
Local storage references require their original local files to be accessible; otherwise
stop rather than silently losing them. A rollback can leave unreferenced encrypted
copies, which are harmless and need no immediate cleanup.

On any failure keep writers stopped: the database/schema/trigger changes roll back;
original image references and objects remain intact. Retry from the beginning after
fixing the reported cause. Never retry conversion after it has committed; the command
refuses an already-applied 0137 or unresolved failed migration. Fresh empty databases
continue using ordinary `db:migrate` without production content keys.

After success, merge/deploy only the compatible encrypted release, verify health and
protected read/write/image access, then resume traffic and workers. Do not roll back
by starting plaintext writers against ciphertext. A database restore is a separate
operator recovery decision. Original image copies and backups still contain plaintext
until their separately approved retention/cleanup; do not claim they were encrypted.

## Verification

Isolated tests use synthetic key providers, never production keys. The disposable
Postgres test database uses UTC, matching timestamp/revision test contracts. API and
assistant suites require synthetic service/auth/LiveKit variables and an official
OpenAI base URL because transport tests mock that endpoint. No provider calls are
needed by the encryption tests.

```sh
# DATABASE_URL must point to a disposable migrated local database, never production.
MEMORY_ISOLATED_DB=1 corepack pnpm --filter @readymeet/db test
corepack pnpm --filter @readymeet/api test
corepack pnpm --filter @readymeet/assistant-service test
corepack pnpm --filter @readymeet/web test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm lint:verify
python3 -m unittest discover -s meeting-agent/tests -p test_private_logging.py
python3 -m unittest discover -s livekit-realtime/tests -p test_logging_utils.py
```

Added table-driven tests cover every protected field, JSON defaults, nulls, Unicode,
wrong-record substitution, real raw ciphertext inspection, select/include, rollback,
concurrent title CAS, unchanged transcript replay, lookup uniqueness and tampering.
API asset tests inspect encrypted local file bytes before decrypting them. Production
load has not been measured; bulk protected updates perform record-bound key operations
inside transactions. Full LiveKit voice runtime tests and production cutover remain
unverified.
