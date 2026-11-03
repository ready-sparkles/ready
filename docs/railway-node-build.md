# Node service images on Railway

`Dockerfile.node` builds the API, assistant, and web with Node 22 and the
`packageManager` version from the root `package.json`. It bypasses Railpack's
package-manager resolver without changing dependencies or the lockfile.

For each Node service, use the repository root as the build context and set the
Dockerfile path to `Dockerfile.node`. Set the Railway variable `NODE_WORKSPACE`:

| Service   | `NODE_WORKSPACE`               |
| --------- | ------------------------------ |
| API       | `@readymeet/api`               |
| Assistant | `@readymeet/assistant-service` |
| Web       | `@readymeet/web`               |

Railway passes declared Docker build arguments from matching service variables.
Keep each service's existing start command. The image also has a default start
command for the selected workspace. Python services keep their existing builders.

For the web image, set `NEXT_PUBLIC_API_BASE_URL` to the public API URL. The other
supported public arguments preserve the application's production defaults:
`NEXT_PUBLIC_DEBUG_NEW_EXTRACTION=false`, `NEXT_PUBLIC_DEBUG_SELECTION=false`,
and `NEXT_PUBLIC_AMBIENT_CONTEXT_ENABLED=true`. Preserve any existing overrides.
These values are compiled into browser code; changing them requires a rebuild.

Do not pass production secrets as build arguments. Prisma generation uses a dummy
URL without connecting to a database. Next.js receives a build-only placeholder
for its auth schema; that placeholder is not a runtime environment variable.
Runtime credentials, including `AUTH_SECRET`, remain required service variables.
`.dockerignore` excludes local environments, credentials, generated files and caches.

## Local verification

```sh
docker build --platform linux/amd64 -f Dockerfile.node \
  --build-arg NODE_WORKSPACE=@readymeet/api -t readymeet-api .
docker build --platform linux/amd64 -f Dockerfile.node \
  --build-arg NODE_WORKSPACE=@readymeet/assistant-service -t readymeet-assistant .
docker build --platform linux/amd64 -f Dockerfile.node \
  --build-arg NODE_WORKSPACE=@readymeet/web \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.ready.app -t readymeet-web .
docker run --rm --platform linux/amd64 readymeet-api sh -c \
  'test -f api/dist/index.js && test -f db/generated/prisma/client.ts && test "$(pnpm --version)" = 10.34.9'
docker run --rm --platform linux/amd64 readymeet-assistant sh -c \
  'test -f assistant/dist/index.js && test -f db/generated/prisma/client.ts'
docker run --rm --platform linux/amd64 readymeet-web sh -c \
  'test -f web/.next/BUILD_ID && test -z "$AUTH_SECRET" && test ! -e .env'
```

This build change does not perform a data migration. Follow
[the content-preserving encryption cutover](meeting-content-encryption.md) before
starting the encrypted release against an existing production database. Keep
old plaintext writers stopped after conversion commits.
