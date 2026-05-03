import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

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
