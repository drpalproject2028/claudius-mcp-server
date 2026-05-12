// Gmail multi-account helpers.
// Tokens vivem em Supabase (tabela gmail_tokens). Refresh transparente.

const SUPA_URL = "https://btkdpjlltekssobfzdhu.supabase.co";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

// Service role bypassa RLS — usado apenas server-side neste servidor MCP.
function adminHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export type Account = "paulo.branco" | "drpalproject2028" | "omestredenada" | "dc4.portobaixa";

export const ACCOUNT_EMAILS: Record<string, string> = {
  "paulo.branco": "paulo.branco@gmail.com",
  drpalproject2028: "drpalproject2028@gmail.com",
  omestredenada: "omestredenada@gmail.com",
  "dc4.portobaixa": "dc4.portobaixa@gmail.com",
};

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
];

export function buildAuthUrl(account: string, redirectUri: string): string {
  const state = Buffer.from(JSON.stringify({ account, ts: Date.now() })).toString("base64url");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // força refresh_token mesmo se já autorizou antes
    state,
    login_hint: ACCOUNT_EMAILS[account] ?? "",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
    id_token?: string;
  };
}

export async function refreshToken(refresh_token: string) {
  const body = new URLSearchParams({
    refresh_token,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as { access_token: string; expires_in: number };
}

export async function upsertToken(account: string, email: string, t: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}) {
  const expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/gmail_upsert_token`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      p_account: account,
      p_email: email,
      p_access_token: t.access_token,
      p_refresh_token: t.refresh_token,
      p_expires_at: expires_at,
      p_scopes: t.scope.split(" "),
    }),
  });
  if (!r.ok) throw new Error(`upsert failed: ${r.status} ${await r.text()}`);
  return r.json();
}

type TokenInfo = {
  account: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
  needs_refresh: boolean;
};

export async function getActiveToken(account: string): Promise<TokenInfo> {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/gmail_get_token_info`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ p_account: account }),
  });
  if (!r.ok) throw new Error(`get_token failed: ${r.status} ${await r.text()}`);
  const info = (await r.json()) as TokenInfo;

  if (info.needs_refresh) {
    const refreshed = await refreshToken(info.refresh_token);
    const newExpires = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await fetch(`${SUPA_URL}/rest/v1/rpc/gmail_refresh_access`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        p_account: account,
        p_new_access: refreshed.access_token,
        p_new_expires_at: newExpires,
      }),
    });
    info.access_token = refreshed.access_token;
    info.expires_at = newExpires;
    info.needs_refresh = false;
  }
  return info;
}

export async function listActiveAccounts() {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/gmail_list_active_accounts`, {
    method: "POST",
    headers: adminHeaders(),
    body: "{}",
  });
  if (!r.ok) throw new Error(`list_accounts failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<Array<{
    account: string;
    email: string;
    authorized_at: string;
    last_used_at: string | null;
    expires_in_min: number;
  }>>;
}

// Busca raw na Gmail API com auto-refresh transparente.
export async function gmailApi(account: string, path: string, init?: RequestInit) {
  const info = await getActiveToken(account);
  const url = `https://gmail.googleapis.com/gmail/v1/users/me${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${info.access_token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return r;
}
