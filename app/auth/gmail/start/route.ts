import { NextRequest } from "next/server";
import { ACCOUNT_EMAILS, buildAuthUrl } from "../../../../lib/gmail";

const VALID_ACCOUNTS = new Set(Object.keys(ACCOUNT_EMAILS));

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account") ?? "";

  if (!VALID_ACCOUNTS.has(account)) {
    return new Response(
      `<h1>Conta inválida</h1>
<p>Permitidas: ${[...VALID_ACCOUNTS].join(", ")}.</p>
<p>Uso: <code>/auth/gmail/start?account=omestredenada</code></p>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const origin = `${url.protocol}//${url.host}`;
  const redirectUri = `${origin}/auth/gmail/callback`;
  const authUrl = buildAuthUrl(account, redirectUri);

  return Response.redirect(authUrl, 302);
}
