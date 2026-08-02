# Memória Tipada Ao Vivo via MCP — Design (v2)

> **Estado**: direcção aprovada após segunda opinião externa (ChatGPT 5). Substitui a
> v1 (imitação da Memory Tool da Anthropic). Ainda por implementar.

## Origem e histórico da decisão

Sessão de auditoria da memória persistente do CLAUDIUS, 01-02/08/2026. Descobriu-se
que a categoria `pending` de `claudius_memory` tinha crescido para 3.207 itens em 4
meses, nunca consolidados — a esmagadora maioria ruído de baixo valor (achados de
revisões truncadas, factos genéricos sem acção real). Resolvido pontualmente
arquivando os 3.207 em bloco; este documento é a correcção estrutural.

**v1** propunha replicar o vocabulário de comandos da "Memory Tool" da Anthropic
(`memory_20250818`: view/create/str_replace/insert/delete/rename sobre um caminho
virtual `/memories`) como ferramentas MCP com nomes próprios. Submetida a uma segunda
opinião externa (ChatGPT 5, com o prompt completo em
`prompt_chatgpt5_memory_mcp_review.md`), que identificou o defeito central: **a v1
copiava a interface visível da Memory Tool, não a vantagem real dela** (o modelo estar
treinado nesse esquema exacto de ferramenta + a instrução de sistema automática que a
API injecta só quando se usa o tipo `memory_20250818` nativo). Ferramentas MCP com
nomes próprios não herdam nada disso — só herdam o custo de construir um sistema de
ficheiros virtual sem a vantagem que o justificava.

O diagnóstico mais amplo da revisão, aceite aqui: o problema não é só o *momento* da
captura (pós-facto vs. ao vivo) — é a falta de (1) orçamento/critério de admissão no
que entra em memória, (2) tipagem clara (decisão ≠ preferência ≠ tarefa ≠ ruído), (3)
ciclo de vida (nada define quando algo expira, resolve ou é promovido).

## Sequência de implementação (staged, mais barato primeiro)

**Passo 1 — antes de construir nada:** reforçar só o prompt de extracção do
`session-archiver.sh` (máximo 3 candidatos por sessão, lista explícita do que NÃO
gravar, exigir evidência + próximo passo + âmbito por candidato, permitir lista
vazia). Grátis, testável numa sessão. Só avançar para os passos seguintes se isto,
sozinho, não travar o crescimento do ruído.

**Passo 2 — só se o Passo 1 for insuficiente:** construir a versão lean abaixo.

## Objectivo

Dar ao agente (eu, durante uma sessão Claude Code ao vivo) uma forma de gravar memória
tipada, com critério, no momento em que decide que algo importa — em vez de depender
inteiramente de um segundo LLM a reconstruir isso meses depois a partir de um
transcript sem contexto.

## Não-objectivos

- Não substitui `claudius_session_state`, `claudius_live_channel`, nem
  `unified_conversations` (RAG/vaultdb) — resolvem problemas diferentes.
- Não é uma árvore de ficheiros virtual. Nada de `view`/`str_replace` por linha/`rename`.
- Não cobre claude.ai web/iOS no piloto — só Claude Code CLI, via este MCP server. A
  camada de armazenamento fica agnóstica à origem para permitir adaptadores depois.
- O `session-archiver.sh` não é substituído nem desligado — corre em **shadow mode**:
  continua a gerar candidatos, mas deixa de gravar directamente em memória activa
  (ver secção "Convivência com o extractor antigo").

## Ferramentas MCP (3, não 6)

| Ferramenta | Direcção | Faz |
|---|---|---|
| `memory_context` | leitura | Dado `project_id`/`repository`/`branch`/`task`, devolve um manifesto curto: decisões activas, pendentes reais, restrições, último checkpoint. Chamada no início de uma sessão (ver "Descoberta"). |
| `memory_record` | escrita | Grava UMA memória tipada (ver schema). Nunca recebe paths — recebe `kind`/`scope`/`key`/`summary`/`rationale`/`source_session_id`/`expires_at`/`idempotency_key`. |
| `memory_resolve` | escrita | Fecha uma memória existente: `resolved`/`superseded`/`archived`, nunca DELETE físico. Exige `expected_version` (concorrência optimista). |

Tipos (`kind`) iniciais, fechados — sem bucket genérico "fact":
`decision`, `preference`, `lesson`, `open_action`, `checkpoint`.

## Schema

```sql
create table claudius_agent_memory (
  id uuid primary key default gen_random_uuid(),

  owner_id uuid not null,               -- Paulo, único por agora; existe para o dia de haver mais
  project_id text,
  scope text not null,                  -- 'global' | 'project' | 'session'
  kind text not null check (kind in ('decision','preference','lesson','open_action','checkpoint')),
  memory_key text not null,             -- slug estável dentro do scope+kind

  summary text not null,
  rationale text,
  next_action text,                     -- obrigatório quando kind = 'open_action'

  status text not null default 'active' check (status in ('active','resolved','superseded','archived')),

  source_type text not null,            -- 'live_session' | 'post_hoc_extractor' | 'human'
  source_session_id text,
  source_reference jsonb,
  trust_level text not null default 'agent_observed',  -- ver secção Segurança

  created_by_instance text not null,
  updated_by_instance text not null,

  version bigint not null default 1,
  idempotency_key text unique,

  expires_at timestamptz,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  unique (owner_id, project_id, scope, kind, memory_key)
);

create table claudius_agent_memory_events (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references claudius_agent_memory(id),
  operation text not null,              -- 'created' | 'updated' | 'resolved' | 'superseded' | 'archived'
  actor_instance text not null,
  session_id text,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
```

`updated_at` actualizado explicitamente em cada operação (não confiar em `DEFAULT
now()`, que só actua no INSERT).

## Descoberta (como sei que existe memória a consultar)

Sem a instrução automática de sistema que a Anthropic injecta só para o tipo nativo
`memory_20250818`. Solução: instrução explícita no `CLAUDE.md` do CLAUDIUS a dizer
para chamar `memory_context(project_id=..., task=...)` no início de trabalho
substancial num projecto — mesmo padrão de "abrir o Claude Code na pasta do projecto
carrega o contexto certo" já em uso.

## Segurança

**Risco principal: injecção de prompt persistente, não path traversal** (não há paths
livres nesta versão — `memory_key` é um slug validado, não um caminho). Uma memória
pode ter origem em conteúdo que atravessou pipelines com input externo (Telegram, web).
Se reinjectada como contexto de confiança numa sessão futura, isso é um vector de
prompt injection persistente.

Mitigação:
- `trust_level` obrigatório em cada registo (`agent_observed` por omissão; `human_confirmed`
  para o que o Paulo confirmou explicitamente).
- `memory_context()` devolve o conteúdo já envolto como dados citados — mesmo padrão
  já usado nesta sessão para resultados de queries Supabase (`<untrusted-data>...`),
  nunca como instrução de sistema.
- Nenhuma operação de escrita aceita conteúdo vindo directamente de uma fonte externa
  não confiada sem passar primeiro por uma sessão viva com um humano a validar.

**RLS/autorização**: a tabela fica sob RLS explícito; o `service_role` key (que
contorna RLS) só é usado pelo próprio servidor MCP, nunca exposto a clientes. Sem
delete físico nesta versão — só `memory_resolve` com estados fechados.

## Convivência com o extractor antigo (`session-archiver.sh`)

Não faz sentido "se houve escrita ao vivo, salta o extractor" — uma sessão pode ter
uma escrita ao vivo e deixar três decisões por registar. Em vez disso, **shadow
mode**: o extractor continua a correr, mas passa a produzir só *candidatos* (não
grava directamente em `claudius_agent_memory`), comparáveis com o que foi escrito ao
vivo na mesma sessão — permite medir sobreposição, omissões e falsos positivos antes
de decidir se o extractor continua a ter um papel definitivo.

## Critérios de sucesso do piloto

Não medir pelo número de memórias criadas. Medir por:

- ≤ 3 memórias novas por sessão em média
- ≥ 80% consideradas úteis numa auditoria humana por amostragem
- 100% dos `open_action` com `next_action` preenchido
- 0 `open_action` sem `owner_id`
- 0 eliminações físicas sem rasto em `claudius_agent_memory_events`
- candidatos do extractor não promovidos expiram em 30 dias

## Perguntas ainda em aberto

1. `owner_id` fixo (só o Paulo) simplifica a v1 deste piloto — mas o schema já
   suporta mais tarde, sem migração, se algum dia isto servir outra pessoa.
2. O prompt reforçado do Passo 1 pode, sozinho, já ser suficiente — só saberemos depois
   de o testar. Este documento assume que não é, para efeitos de desenho, mas a
   decisão de avançar para o Passo 2 depende desse teste.
