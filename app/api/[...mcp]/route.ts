import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const PAL_API = "https://btkdpjlltekssobfzdhu.supabase.co/functions/v1/pal-api";
const PAL_KEY = process.env.PAL_API_KEY ?? "pal-2026-claudius";

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

    // ── 5. Pesquisa nas conversas ────────────────────────────────────────
    server.tool(
      "search_conversations",
      "Pesquisa semântica nas 1448 conversas CLAUDIUS (ChatGPT + Claude) guardadas no Supabase.",
      { query: z.string().min(2) },
      async ({ query }) => {
        const data = await palFetch(
          `/search?q=${encodeURIComponent(query)}&limit=5`
        );
        const results = (data.results ?? [])
          .map(
            (r: { title: string; snippet: string; source: string }) =>
              `**${r.title}** (${r.source})\n${r.snippet}`
          )
          .join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text",
              text: results || "Sem resultados para essa pesquisa.",
            },
          ],
        };
      }
    );
  },
  {},
  { basePath: "/api", maxDuration: 60 }
);

export { handler as GET, handler as POST, handler as DELETE };
