/** Cookie-authenticated writes must originate in our own dialog, not an embedder. */
export function isOutlookDialogRequest(request: Request): boolean {
  // Next can normalize request.url to localhost behind its server/proxy. The
  // browser's Host header retains the requested authority. Browsers cannot
  // forge Host or Origin; neither is accepted from the request body.
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;

  return (
    request.headers.get("origin") === `${url.protocol}//${host}` &&
    request.headers.get("content-type")?.split(";")[0]?.trim() === "application/json"
  );
}
