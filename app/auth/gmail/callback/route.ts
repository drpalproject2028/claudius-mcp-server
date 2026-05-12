import { NextRequest } from "next/server";
import { ACCOUNT_EMAILS, exchangeCode, upsertToken } from "../../../../lib/gmail";

const VALID_ACCOUNTS = new Set(Object.keys(ACCOUNT_EMAILS));

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Gmail Auth</title>
<style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.5;color:#222}h1{color:#0a7c2f}code{background:#f0f0f0;padding:2px 6px;border-radius:4px}.err{color:#b00}</style>
</head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) {
    return html(`<h1 class="err">❌ OAuth recusado</h1><p>${err}</p>`, 400);
  }
  if (!code || !stateRaw) {
    return html(`<h1 class="err">❌ Faltam parâmetros</h1><p>Faltam <code>code</code> ou <code>state</code>.</p>`, 400);
  }

  let account: string;
  try {
    const decoded = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf-8"));
    account = decoded.account;
  } catch {
    return html(`<h1 class="err">❌ State inválido</h1>`, 400);
  }

  if (!VALID_ACCOUNTS.has(account)) {
    return html(`<h1 class="err">❌ Conta inválida</h1><p>${account}</p>`, 400);
  }

  const origin = `${url.protocol}//${url.host}`;
  const redirectUri = `${origin}/auth/gmail/callback`;

  try {
    const tokens = await exchangeCode(code, redirectUri);
    if (!tokens.refresh_token) {
      return html(
        `<h1 class="err">⚠️ Sem refresh_token</h1>
<p>Google não devolveu refresh_token (provavelmente já tinhas consentido). Vai a <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, remove acesso a "CLAUDIUS" e tenta de novo.</p>`,
        400
      );
    }
    const expectedEmail = ACCOUNT_EMAILS[account];
    await upsertToken(account, expectedEmail, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
    });
    return html(
      `<h1>✅ ${expectedEmail} autorizada</h1>
<p>Conta <code>${account}</code> ligada com sucesso ao claudius-mcp-server.</p>
<p>Scopes: <code>${tokens.scope}</code></p>
<p>Podes fechar esta janela. Se faltam contas, volta a <a href="/auth/gmail/start?account=omestredenada">/auth/gmail/start?account=&lt;outra&gt;</a>.</p>`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return html(`<h1 class="err">❌ Falha na troca de tokens</h1><pre>${msg}</pre>`, 500);
  }
}
