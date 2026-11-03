import { auth } from "../../../../auth";

export async function GET(): Promise<Response> {
  const session = await auth();

  return Response.json(
    {
      user:
        session?.apiToken !== undefined && session.apiToken.length > 0 && session.appUser !== undefined
          ? { email: session.appUser.email, displayName: session.appUser.displayName }
          : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
