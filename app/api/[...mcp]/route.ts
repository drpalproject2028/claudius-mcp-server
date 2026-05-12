import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  ACCOUNT_EMAILS,
  getActiveToken,
  gmailApi,
  listActiveAccounts,
} from "../../../lib/gmail";

const ACCOUNT_ENUM = ["paulo.branco", "drpalproject2028", "omestredenada", "dc4.portobaixa"] as const;

const PAL_API = "https://btkdpjlltekssobfzdhu.supabase.co/functions/v1/pal-api";
const PAL_KEY = process.env.PAL_API_KEY ?? "pal-2026-claudius";
const SUPA_URL = "https://btkdpjlltekssobfzdhu.supabase.co";
const SUPA_ANON = process.env.SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0a2RwamxsdGVrc3NvYmZ6ZGh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NzA4ODgsImV4cCI6MjA4NjI0Njg4OH0.6IwYG23OD9Rh2fpVMlGiaZy77d3CKczpudIzjZ9dEZM";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";

const SITES = [
  { name: "CLAUDIUS Dashboards", url: "https://claudius-dashboards.vercel.app" },
  { name: "PACT V-B", url: "https://claudius-dashboards.vercel.app/pact.html" },
  { name: "Focus Meter", url: "https://palcore-focus-meter.vercel.app" },
  { name: "Decision Partner", url: "https://palcore-decision-partner.vercel.app" },
  { name: "Ex Libris", url: "https://exlibris-generator.vercel.app" },
];

async function palFetch(path: string) {
  const res = await fetch(`${PAL_API}${path}`, {
    headers: { Authorization: `Bearer ${PAL_KEY}` },
  });
  return res.json();
}

const handler = createMcpHandler(
  (server) => {
    // ── 1. Estado da sessão ──────────────────────────────────────────────
    server.tool(
      "get_session_state",
      "Lê o estado actual da sessão CLAUDIUS: pendentes, decisões tomadas, foco actual. Usar quando queres saber onde ficou a última sessão.",
      {},
      async () => {
        const data = await palFetch("/memory?key=current_session_state");
        return {
          content: [{ type: "text", text: data.value ?? "Sem estado de sessão guardado." }],
        };
      }
    );

    // ── 2. Estado dos sites ──────────────────────────────────────────────
    server.tool(
      "check_sites",
      "Verifica se os 5 sites Vercel do CLAUDIUS estão online. Retorna status HTTP de cada um.",
      {},
      async () => {
        const results = await Promise.all(
          SITES.map(async ({ name, url }) => {
            try {
              const r = await fetch(url, { method: "HEAD" });
              return `${r.ok ? "✅" : "⚠️"} ${name}: ${r.status}`;
            } catch {
              return `❌ ${name}: sem resposta`;
            }
          })
        );
        return { content: [{ type: "text", text: results.join("\n") }] };
      }
    );

    // ── 3. Últimas execuções dos agentes ─────────────────────────────────
    server.tool(
      "get_agent_executions",
      "Mostra as últimas execuções dos agentes CLAUDIUS (claudius-logger, claudius-gmail-monitor, etc.) com status e timestamp.",
      { limit: z.number().int().min(1).max(20).default(10) },
      async ({ limit }) => {
        const data = await palFetch(`/executions?limit=${limit}`);
        const lines = (data.executions ?? []).map(
          (e: { agent_name: string; status: string; created_at: string }) =>
            `• ${e.agent_name}: ${e.status} — ${new Date(e.created_at).toLocaleString("pt-PT")}`
        );
        return {
          content: [
            {
              type: "text",
              text: lines.length ? lines.join("\n") : "Sem execuções encontradas.",
            },
          ],
        };
      }
    );

    // ── 4. Status completo do sistema ────────────────────────────────────
    server.tool(
      "get_system_status",
      "Resumo completo do sistema CLAUDIUS: estado da sessão + sites + últimas execuções de agentes. Ideal para o briefing de início de sessão.",
      {},
      async () => {
        const [sessionData, execData] = await Promise.all([
          palFetch("/memory?key=current_session_state"),
          palFetch("/executions?limit=5"),
        ]);

        const siteResults = await Promise.all(
          SITES.map(async ({ name, url }) => {
            try {
              const r = await fetch(url, { method: "HEAD" });
              return `${r.ok ? "✅" : "⚠️"} ${name}`;
            } catch {
              return `❌ ${name}`;
            }
          })
        );

        const execLines = (execData.executions ?? [])
          .map(
            (e: { agent_name: string; status: string; created_at: string }) =>
              `• ${e.agent_name}: ${e.status}`
          )
          .join("\n");

        const text = [
          "## Estado CLAUDIUS\n",
          "**Sites:**",
          siteResults.join("\n"),
          "",
          "**Agentes (últimas 5 execuções):**",
          execLines || "sem dados",
          "",
          "**Sessão:**",
          sessionData.value ?? "sem estado guardado",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }
    );

    // ── 5. Guardar estado da sessão ──────────────────────────────────────
    server.tool(
      "save_session_state",
      "Guarda o estado actual da sessão CLAUDIUS no Supabase (pendentes, decisões tomadas, foco). Usar ao fechar sessão no iPhone para garantir continuidade na próxima sessão no Mac ou noutro dispositivo.",
      { content: z.string().min(1) },
      async ({ content }) => {
        await fetch(`${PAL_API}/memory`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PAL_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ key: "current_session_state", value: content }),
        });
        return { content: [{ type: "text", text: "✅ Estado guardado no Supabase. Disponível na próxima sessão em qualquer dispositivo." }] };
      }
    );

    // ── 6. Pesquisa nas conversas (vectorial via OpenAI + pgvector) ────
    server.tool(
      "search_conversations",
      "Pesquisa semântica nas 1495 conversas CLAUDIUS (ChatGPT + Claude) guardadas no Supabase. Usa embeddings vectoriais para encontrar resultados conceptualmente próximos.",
      { query: z.string().min(2) },
      async ({ query }) => {
        if (!OPENAI_KEY) {
          const ftRes = await fetch(`${SUPA_URL}/rest/v1/rpc/semantic_search`, {
            method: "POST",
            headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query_text: query, match_count: 8 }),
          });
          const ftRows = await ftRes.json();
          const ftResults = (Array.isArray(ftRows) ? ftRows : [])
            .map((r: { title: string; source: string; search_text?: string; similarity: number }) =>
              `**${r.title}** (${r.source}, score: ${r.similarity.toFixed(3)})\n${(r.search_text ?? "").substring(0, 200)}`
            ).join("\n\n---\n\n");
          return { content: [{ type: "text", text: ftResults || "Sem resultados." }] };
        }
        const embRes = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: query, model: "text-embedding-3-small" }),
        });
        const embData = await embRes.json();
        const embedding = embData?.data?.[0]?.embedding;
        if (!embedding) {
          return { content: [{ type: "text", text: "Erro ao gerar embedding para a query." }] };
        }
        const vecStr = "[" + embedding.join(",") + "]";
        const res = await fetch(`${SUPA_URL}/rest/v1/rpc/search_conversations_semantic`, {
          method: "POST",
          headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query_embedding: vecStr, match_count: 8, similarity_threshold: 0.2 }),
        });
        const rows = await res.json();
        const results = (Array.isArray(rows) ? rows : [])
          .map((r: { title: string; source: string; similarity: number; first_message_at?: string }) =>
            `**${r.title}** (${r.source}, similarity: ${r.similarity.toFixed(3)}, ${(r.first_message_at ?? "").substring(0, 10)})`
          ).join("\n\n---\n\n");
        return { content: [{ type: "text", text: results || "Sem resultados para essa pesquisa." }] };
      }
    );

    // ── 7. Concept Query — Ciclo de vida dos conceitos (Camada 2) ───────
    server.tool(
      "concept_query",
      "Consulta o ciclo de vida dos conceitos CLAUDIUS (Camada 2 da memória composta). Modos: lifecycle (estado actual), evidence (snippets), relations (co-ocorrências), timeline (série mensal). Exemplos: 'Quando nasceu PALCORE?', 'Que conceitos estão dormentes?', 'Evolução do wardrobe-emanuel'.",
      {
        concept_path: z.string().describe("Caminho do conceito (ex: /RESSONANCIA/sistema/palcore) ou wildcard (* para todos, /RESSONANCIA/sistema/* para um ramo)"),
        mode: z.enum(["lifecycle", "evidence", "relations", "timeline"]).default("lifecycle"),
      },
      async ({ concept_path, mode }) => {
        const res = await fetch(`${SUPA_URL}/rest/v1/rpc/claudius_concept_query`, {
          method: "POST",
          headers: {
            apikey: SUPA_ANON,
            Authorization: `Bearer ${SUPA_ANON}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_concept_path: concept_path, p_mode: mode }),
        });
        const data = await res.json();
        if (!res.ok) {
          return { content: [{ type: "text", text: `Erro: ${JSON.stringify(data)}` }] };
        }
        const rows = Array.isArray(data) ? data : [data];
        if (!rows.length || rows[0] === null) {
          return { content: [{ type: "text", text: "Nenhum conceito encontrado para esse caminho." }] };
        }
        const text = JSON.stringify(rows, null, 2);
        return { content: [{ type: "text", text: text.substring(0, 8000) }] };
      }
    );

    // ── 8. Concept Status Summary (via SECURITY DEFINER RPC) ─────────────
    server.tool(
      "concept_status",
      "Resumo rápido do estado da Camada 2: quantos conceitos alive/dormant/born/unborn, top 10 mais frequentes, último pulse.",
      {},
      async () => {
        const res = await fetch(`${SUPA_URL}/rest/v1/rpc/claudius_concept_status_summary`, {
          method: "POST",
          headers: {
            apikey: SUPA_ANON,
            Authorization: `Bearer ${SUPA_ANON}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `Erro: ${err}` }] };
        }
        const data: {
          counts: Record<string, number>;
          top10: Array<{
            concept_path: string;
            display_name: string;
            status: string;
            occurrences_total: number;
            born_at: string;
            last_seen_at: string;
          }>;
          total: number;
          last_pulse: string | null;
        } = await res.json();
        const top10 = data.top10.map(
          r => `  ${r.occurrences_total.toString().padStart(4)} ${r.display_name} [${r.status}]`
        );
        const summary = [
          "## CLAUDIUS Concept Lifecycle — Estado",
          "",
          "**Contadores por status:**",
          ...Object.entries(data.counts).map(([s, n]) => `  ${s}: ${n}`),
          "",
          "**Top 10 conceitos:**",
          ...top10,
          "",
          `**Total:** ${data.total} conceitos`,
          `**Último pulse:** ${data.last_pulse ?? "—"}`,
        ].join("\n");
        return { content: [{ type: "text", text: summary }] };
      }
    );
    const parseRpcResponse = async (res: Response): Promise<string> => {
      const ct = res.headers.get("content-type") ?? "";
      if (res.status === 204) return "OK (204 No Content)";
      const text = await res.text();
      if (!ct.includes("application/json") || !text) return (text || "OK").substring(0, 8000);
      try {
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed, null, 2).substring(0, 8000);
      } catch {
        return text.substring(0, 8000);
      }
    };

    // ── 9. start_session — Inicia sessão CLAUDIUS (protocolo v4.0) ──────
    server.tool(
      "start_session",
      "Inicia uma nova sessão CLAUDIUS via RPC claudius_inicio (protocolo v4.0). Devolve session_id (necessário para update_session e end_session), últimas 5 sessões e pendentes abertos nos últimos 14 dias.",
      {
        instance: z.enum([
          "claude-code-sonnet",
          "claude-code-opus",
          "claude-opus-4-7-web",
          "claude-desktop",
          "cowork",
          "claude-ai-ios",
          "claude-ai-web",
        ]).describe("Nome canónico da instância. iPhone Claude.ai = 'claude-ai-ios'. Browser desktop = 'claude-ai-web'."),
        focus: z.string().trim().max(500).optional().describe("Tema/foco principal da sessão (curto, ex: 'auditoria-mcp')"),
      },
      async ({ instance, focus }) => {
        const res = await fetch(`${SUPA_URL}/rest/v1/rpc/claudius_inicio`, {
          method: "POST",
          headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_instance: instance, p_focus: focus ?? null }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `Erro: ${err.substring(0, 8000)}` }] };
        }
        return { content: [{ type: "text", text: await parseRpcResponse(res) }] };
      }
    );

    // ── 10. update_session — Adiciona nota à sessão actual ──────────────
    server.tool(
      "update_session",
      "Adiciona uma nota factual à sessão CLAUDIUS actual via RPC claudius_update.",
      {
        session_id: z.number().int().positive().describe("ID devolvido por start_session"),
        nota: z.string().trim().min(1).max(2000).describe("Nota curta e factual (ex: 'Criado workflow n8n IFRa2H... para BCP')"),
      },
      async ({ session_id, nota }) => {
        const res = await fetch(`${SUPA_URL}/rest/v1/rpc/claudius_update`, {
          method: "POST",
          headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_session_id: session_id, p_nota: nota }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `Erro: ${err.substring(0, 8000)}` }] };
        }
        return { content: [{ type: "text", text: await parseRpcResponse(res) }] };
      }
    );

    // ── 11. end_session — Fecha a sessão actual ─────────────────────────
    server.tool(
      "end_session",
      "Fecha a sessão CLAUDIUS actual via RPC claudius_fim. Persiste decisões, artefactos, pendentes e resumo.",
      {
        session_id: z.number().int().positive().describe("ID devolvido por start_session"),
        decisions: z.array(z.string().trim().min(1).max(500)).default([]).describe("Lista de decisões tomadas na sessão"),
        artifacts: z.array(z.string().trim().min(1).max(500)).default([]).describe("Lista de ficheiros/URLs/artefactos criados"),
        pending: z.array(z.object({
          id: z.string().trim().min(1),
          acao: z.string().trim().min(1),
          prioridade: z.string().optional(),
        })).default([]).describe("Lista de pendentes abertos para próxima sessão"),
        resumo: z.string().trim().min(1).max(2000).optional().describe("Resumo em 1-3 linhas do que foi feito"),
      },
      async ({ session_id, decisions, artifacts, pending, resumo }) => {
        const res = await fetch(`${SUPA_URL}/rest/v1/rpc/claudius_fim`, {
          method: "POST",
          headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            p_session_id: session_id,
            p_decisions: decisions,
            p_artifacts: artifacts,
            p_pending: pending,
            p_resumo: resumo ?? null,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: "text", text: `Erro: ${err.substring(0, 8000)}` }] };
        }
        return { content: [{ type: "text", text: await parseRpcResponse(res) }] };
      }
    );

    // ── 12. gmail_list_accounts — contas Gmail autorizadas ───────────────
    server.tool(
      "gmail_list_accounts",
      "Lista contas Gmail autorizadas no servidor (paulo.branco, drpalproject2028, omestredenada, dc4.portobaixa) — sem expor tokens. Mostra email, quando foi autorizada, quando foi usada pela última vez e minutos até expirar.",
      {},
      async () => {
        try {
          const accounts = await listActiveAccounts();
          if (!accounts.length) {
            const authUrls = Object.keys(ACCOUNT_EMAILS).map(a => `  /auth/gmail/start?account=${a}`).join("\n");
            return { content: [{ type: "text", text: `Nenhuma conta autorizada ainda. Para autorizar:\n${authUrls}` }] };
          }
          const lines = accounts.map(a =>
            `• ${a.account} (${a.email}) — autorizada ${a.authorized_at?.substring(0, 10)}, último uso ${a.last_used_at?.substring(0, 16) ?? "nunca"}, expira em ${a.expires_in_min}min`
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${(e as Error).message}` }] };
        }
      }
    );

    // ── 13. gmail_search — pesquisa numa conta específica ────────────────
    server.tool(
      "gmail_search",
      "Pesquisa threads em UMA conta Gmail específica usando query Gmail (operadores: from:, to:, subject:, after:YYYY/MM/DD, before:, has:attachment, label:, etc.). Devolve sender, subject, snippet, data.",
      {
        account: z.enum(ACCOUNT_ENUM).describe("Conta a pesquisar"),
        query: z.string().min(1).describe("Query Gmail (ex: 'from:billing@stripe.com after:2025/08/01')"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      async ({ account, query, limit }) => {
        try {
          const listRes = await gmailApi(account, `/threads?q=${encodeURIComponent(query)}&maxResults=${limit}`);
          if (!listRes.ok) {
            const err = await listRes.text();
            return { content: [{ type: "text", text: `Erro Gmail API ${listRes.status}: ${err.substring(0, 400)}` }] };
          }
          const list = await listRes.json() as { threads?: Array<{ id: string }> };
          const threads = list.threads ?? [];
          if (!threads.length) {
            return { content: [{ type: "text", text: `Sem resultados em ${account} para: ${query}` }] };
          }
          // Para cada thread, ir buscar metadata da última mensagem
          const details = await Promise.all(
            threads.slice(0, limit).map(async t => {
              const r = await gmailApi(account, `/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
              if (!r.ok) return null;
              const td = await r.json() as { id: string; messages?: Array<{ id: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } }> };
              const last = td.messages?.[td.messages.length - 1];
              const headers = last?.payload?.headers ?? [];
              const get = (n: string) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
              return {
                id: td.id,
                from: get("From"),
                subject: get("Subject"),
                date: get("Date"),
                snippet: last?.snippet ?? "",
              };
            })
          );
          const rows = details.filter(Boolean) as NonNullable<typeof details[number]>[];
          const text = rows.map(r => `• ${r.date}\n  ${r.from}\n  ${r.subject}\n  ${r.snippet.substring(0, 160)}\n  id=${r.id}`).join("\n\n");
          return { content: [{ type: "text", text: `${rows.length} resultados em ${account} para "${query}":\n\n${text}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${(e as Error).message}` }] };
        }
      }
    );

    // ── 14. gmail_get_thread — corpo completo de uma thread ──────────────
    server.tool(
      "gmail_get_thread",
      "Lê o corpo completo (todas as mensagens, plain text body) de uma thread Gmail numa conta específica.",
      {
        account: z.enum(ACCOUNT_ENUM),
        thread_id: z.string().min(5),
      },
      async ({ account, thread_id }) => {
        try {
          const r = await gmailApi(account, `/threads/${thread_id}?format=full`);
          if (!r.ok) {
            const err = await r.text();
            return { content: [{ type: "text", text: `Erro Gmail API ${r.status}: ${err.substring(0, 400)}` }] };
          }
          const td = await r.json() as {
            id: string;
            messages?: Array<{
              id: string;
              snippet?: string;
              payload?: {
                headers?: Array<{ name: string; value: string }>;
                body?: { data?: string };
                parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: unknown[] }>;
              };
            }>;
          };
          const extractText = (payload: NonNullable<typeof td.messages>[number]["payload"]): string => {
            if (!payload) return "";
            if (payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf-8");
            for (const p of payload.parts ?? []) {
              if (p.mimeType === "text/plain" && p.body?.data) {
                return Buffer.from(p.body.data, "base64").toString("utf-8");
              }
            }
            for (const p of payload.parts ?? []) {
              if (p.mimeType === "text/html" && p.body?.data) {
                return Buffer.from(p.body.data, "base64").toString("utf-8")
                  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              }
            }
            return "";
          };
          const blocks = (td.messages ?? []).map((m, i) => {
            const h = m.payload?.headers ?? [];
            const g = (n: string) => h.find(x => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
            return `=== Mensagem ${i + 1} ===\nFrom: ${g("From")}\nDate: ${g("Date")}\nSubject: ${g("Subject")}\n\n${extractText(m.payload).substring(0, 4000)}`;
          });
          return { content: [{ type: "text", text: blocks.join("\n\n") }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${(e as Error).message}` }] };
        }
      }
    );

    // ── 15. gmail_unified_search — pesquisa em TODAS as contas autorizadas em paralelo ─
    server.tool(
      "gmail_unified_search",
      "Pesquisa a mesma query Gmail em TODAS as contas autorizadas em paralelo. Devolve resultados agrupados por conta. Útil para encontrar invoices/recibos cross-account, ver pegada total de uma pessoa, etc.",
      {
        query: z.string().min(1),
        limit_per_account: z.number().int().min(1).max(20).default(10),
      },
      async ({ query, limit_per_account }) => {
        try {
          const accounts = await listActiveAccounts();
          if (!accounts.length) {
            return { content: [{ type: "text", text: "Nenhuma conta autorizada. Usa /auth/gmail/start?account=X primeiro." }] };
          }
          const perAccount = await Promise.all(accounts.map(async acc => {
            try {
              const r = await gmailApi(acc.account, `/threads?q=${encodeURIComponent(query)}&maxResults=${limit_per_account}`);
              if (!r.ok) return { account: acc.account, error: `${r.status}`, results: [] as Array<{ from: string; subject: string; date: string }> };
              const list = await r.json() as { threads?: Array<{ id: string }> };
              const threads = (list.threads ?? []).slice(0, limit_per_account);
              const details = await Promise.all(threads.map(async t => {
                const dr = await gmailApi(acc.account, `/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
                if (!dr.ok) return null;
                const td = await dr.json() as { messages?: Array<{ snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } }> };
                const last = td.messages?.[td.messages.length - 1];
                const h = last?.payload?.headers ?? [];
                const g = (n: string) => h.find(x => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
                return { from: g("From"), subject: g("Subject"), date: g("Date") };
              }));
              return { account: acc.account, results: details.filter(Boolean) as Array<{ from: string; subject: string; date: string }> };
            } catch (e) {
              return { account: acc.account, error: (e as Error).message, results: [] as Array<{ from: string; subject: string; date: string }> };
            }
          }));
          const blocks = perAccount.map(a => {
            const head = `## ${a.account} (${a.results.length} resultados${'error' in a && a.error ? `, erro: ${a.error}` : ""})`;
            const body = a.results.map(r => `  • ${r.date?.substring(0, 16)} — ${r.from}\n    ${r.subject}`).join("\n");
            return body ? `${head}\n${body}` : head;
          });
          return { content: [{ type: "text", text: blocks.join("\n\n") }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${(e as Error).message}` }] };
        }
      }
    );

  },
  {},
  { basePath: "/api", maxDuration: 60 }
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function withCors(req: Request) {
  const res = await handler(req);
  const next = new Response(res.body, res);
  Object.entries(CORS).forEach(([k, v]) => next.headers.set(k, v));
  return next;
}

export async function GET(req: Request) {
  const accept = req.headers.get("accept") ?? "";
  // SSE or Streamable HTTP GET — let mcp-handler deal with it
  if (accept.includes("text/event-stream") || accept.includes("application/json")) {
    return withCors(req);
  }
  // Health check (usado pelo Claude.ai para verificar se o servidor está vivo)
  return new Response(
    JSON.stringify({ server: "claudius-mcp-admin", version: "1.0.0", status: "ok" }),
    { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
  );
}

export { withCors as POST, withCors as DELETE };
