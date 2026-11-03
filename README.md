# Ready

Ready combines video meetings, personal voice agents, meeting notes and tasks, calendar preparation, and connected mail in a shared workspace. Authenticated invitees and anonymous guests have different access boundaries and post-meeting views. Repository configuration does not establish which optional features or providers are enabled in production.

## License

Ready is source-available under the [Business Source License 1.1](LICENSE). Devin Ersoy and Sam Zetterberg are the licensors. Ready Sparkles, Inc. operates the hosted service.

The additional use grant is None. You may copy, modify, and use the source for non-production purposes. On 2030-11-03, this release is licensed under GPL Version 2.0 or any later version.

To publish a public snapshot without this repository's history, run this from the repository root. It archives the latest commit, not uncommitted edits. The destination must be a new directory outside the repository. The command writes one commit and does not push.

```sh
node scripts/export-public-snapshot.mjs /path/outside/this/repo
```

## Repository layout

| Path                                                       | Runtime / purpose                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [web](web)                                         | Next.js, React, Auth.js, LiveKit meeting UI, workspace and guest experiences, plus the Google Calendar and Outlook add-ons |
| [api](api)                                         | Fastify public API, access policy, integrations, billing, and request-owned processing                                       |
| [assistant](assistant)                             | Internal generation endpoints, transcript callbacks, transcription control, and room-agent dispatch                           |
| [meeting-agent](meeting-agent)                     | Python LiveKit Agents voice worker: solo realtime conversation and group push-to-talk                                         |
| [livekit-realtime](livekit-realtime)               | Python/FastAPI human transcription sidecar using direct ElevenLabs STT                                                        |
| [db](db)                                           | Postgres, Prisma schema, SQL migrations, repositories, seed data                                                              |
| [shared](shared)                                   | Shared contracts, validation, events, and capability vocabulary                                                               |

Ending a meeting starts asynchronous finalization. Transcript completion, notes, tasks, and the frontend reveal animation have separate readiness states. The API awaits generation inside the owning request; the assistant service generates artifacts, and the Python services handle live audio. Interrupted work requires an explicit retry; no background worker resumes it.

## Local development

Install Node/Corepack, the pinned pnpm version from [package.json](package.json), Postgres, and Python 3.10+ (the meeting-agent deployment image uses Python 3.11). Python selector scripts prefer a compatible service-local `.venv`.

1. Copy local configuration templates, then fill in the values needed for your work:

    ```sh
    cp .env.example .env
    cp api/.env.example api/.env
    cp assistant/.env.example assistant/.env
    cp meeting-agent/.env.example meeting-agent/.env
    cp livekit-realtime/.env.example livekit-realtime/.env
    cp web/.env.example web/.env.local
    ```

2. Point `DATABASE_URL` at your local development database. Install Node and Python dependencies:

    ```sh
    corepack pnpm install
    corepack pnpm build:meeting-agent
    corepack pnpm build:livekit-realtime
    ```

    The Python build scripts install separate virtual environments; the realtime build recreates its `.venv`.

3. Apply migrations. Fresh databases use the new baseline; existing ones must first be fully upgraded through historical migration 0132 using the previous release. Seed only a development database if you want the demo fixtures:

    ```sh
    corepack pnpm db:migrate
    corepack pnpm db:seed
    ```

4. Start the five application runtimes and open `http://localhost:3000`:

    ```sh
    corepack pnpm dev
    ```

The web, API, assistant, and realtime HTTP defaults are ports 3000, 4000, 4100, and 4200. The meeting-agent registers with LiveKit. The root dev command runs the Python services without hot reload; `dev:livekit-realtime:reload` is an explicit alternative. This command does not provision Postgres or external providers.

## Configuration and authentication

Root `.env` supplies shared local backend settings; service `.env` files can override them. The web has its own `.env.local`. Templates are starting points; the runtime loaders are authoritative: [API](api/env.ts), [assistant](assistant/env.ts), [meeting-agent](meeting-agent/meeting_agent/env.py), [transcriber](livekit-realtime/app/config.py), and [web auth](web/auth.ts).

- LiveKit credentials stay on servers; browsers receive scoped room tokens.
- Both Python audio services require `ELEVEN_API_KEY` for direct ElevenLabs STT. Blank language settings allow automatic detection.
- Human transcripts save directly from final STT events; live captions are independent. The stream-saving fallback and `readymeet_livekit_realtime_caption_direct_fallback_total` metric are removed. `LIVEKIT_REALTIME_TRANSCRIPT_SOURCE` is ignored, including stale `stream` values. Before deployment, account for active meetings, remove the obsolete setting, and update dashboards. Restoring the old path requires compatible code, not the flag.
- Generation and voice need the relevant OpenAI credentials/model access. Do not treat a local fallback response as proof that a provider works.
- `AUTH_EXCHANGE_SECRET` must match between web and API. Auth.js provider credentials and `AUTH_SECRET` are server-only web settings, not `NEXT_PUBLIC_*` values.
- `ASSISTANT_SERVICE_SECRET` and `LIVEKIT_REALTIME_SERVICE_SECRET` protect their respective internal HTTP boundaries; URLs must be reachable from the calling service.
- `ABLY_API_KEY` belongs in the API, which issues scoped browser tokens and publishes application events directly. Clients do not receive the provider key.
- Solo voice currently uses a realtime model; `MEETING_ASSISTANT_SOLO_RESPONSE_MODE` is no longer read.

Google web sign-in uses `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` and callback `http://localhost:3000/api/auth/callback/google`. Microsoft uses `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and `AUTH_MICROSOFT_ENTRA_ID_ISSUER`, with callback `http://localhost:3000/api/auth/callback/microsoft-entra-id`. Register equivalent HTTPS callbacks for a hosted web domain. `INTERNAL_API_BASE_URL` is the web server's API address; `NEXT_PUBLIC_API_BASE_URL` must be browser-reachable. See [auth implementation](web/auth.ts).

## Commands

Commands run from the repository root; [package scripts](package.json) define their exact behavior.

| Command (`corepack pnpm …`)                                                     | Purpose                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `dev`                                                                           | Start web, API, assistant, voice worker, and transcriber |
| `build:web`, `build:api`, `build:assistant`                                     | Build a Node service                                     |
| `build:meeting-agent`, `build:livekit-realtime`                                 | Install Python runtime dependencies                      |
| `start:web`, `start:assistant`, `start:meeting-agent`, `start:livekit-realtime` | Start the corresponding prepared runtime                 |
| `start:api`                                                                     | Apply tracked migrations, then start the API |
| `db:migrate`, `db:seed`                                                         | Apply schema migrations / populate development fixtures  |
| `typecheck`, `lint`, `test`                                                     | Workspace checks; coverage differs by package            |

Database tests are discovered automatically; `@readymeet/db test:integration` is an alias for its full test suite. CI runs database-backed files and packages serially against isolated Postgres, with `MEMORY_ISOLATED_DB`, `GUEST_PREVIEW_ISOLATED_DB`, `ACCOUNT_DELETION_ISOLATED_DB`, and `READYMEET_ISOLATED_DB` set to `1`.

Python wrapper typecheck/lint scripts compile Python rather than running the TypeScript toolchain. Python regression tests live in each service's `tests` directory. Use focused checks appropriate to a change; provider smoke tests can make paid calls and are separate from unit tests.

## React Doctor CI policy

Pull requests run `react-doctor@0.9.17` on `web` with `--scope changed`, using the PR base SHA. This is a **net-count gate**, not a guarantee that every newly introduced violation is rejected: the pinned CLI compares counts per file and plugin/rule. Existing violations are tolerated; an increased error count in one such group fails CI. Fixing one violation and introducing another of the same rule in the same file can pass, even when the source and line differ. This policy is intentional so existing errors do not block unrelated edits. Warnings remain advisory.

The workflow also validates the JSON report. A degraded or missing baseline comparison, an unsuccessful report, or invalid JSON fails CI even if the CLI exits zero. Any nonzero CLI exit status is preserved. A successful comparison with no changed source files passes, including reports with no projects scanned; it must still contain baseline metadata.

The replacement fixture in `scripts/fixtures/react-doctor-replacement/` checks this policy against the pinned CLI, alongside gate failure and empty-comparison regressions. Run the same tests locally (requires Git, Node 22, pnpm, and registry access for `pnpm dlx`):

```sh
node --test scripts/tests/validate-react-doctor-report.test.mjs
```

## Technical guides

- [Google Calendar add-on setup](web/adapters/primary/google-calendar/README.md)
