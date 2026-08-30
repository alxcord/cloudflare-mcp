# cloudflare-mcp

Uma coleção de servidores MCP (Model Context Protocol) e Workers de apoio para uso pessoal,
rodando em Cloudflare Workers. A maioria dos Workers é uma ponte entre o Claude e um serviço
externo — ela guarda as credenciais do lado do servidor e expõe um endpoint MCP que o Claude
acessa via custom connector. Alguns Workers (como o `comm`) não são MCPs — são peças de apoio
da mesma infraestrutura pessoal, seguindo o mesmo padrão de deploy.

## Arquitetura

- Cada serviço vira **um Worker separado**, com seu próprio subdomínio:
  `<worker>.<seu-dominio>`.
- Cada Worker é **um arquivo único de JavaScript**, sem build step, sem dependências de npm.
  Só usa APIs nativas do runtime do Workers (`fetch`, `crypto.subtle`, `TextEncoder`).
- Nos Workers que são MCPs, a autenticação Claude → Worker é feita por **OAuth 2.1 com PKCE**.
  As credenciais de acesso aos serviços externos ficam como **secrets do Worker no
  Cloudflare** — nunca no código.
- Cada Worker MCP implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP) diretamente:
  `initialize`, `tools/list` e `tools/call`. Sem SDK.

```
Claude (custom connector)
   │  HTTPS POST /mcp  (JSON-RPC, Bearer JWT)
   ▼
Cloudflare Worker (mcp-<servico>.<seu-dominio>)
   │  usa secret PAT/API key/D1 binding
   ▼
API do serviço ou banco de dados (GitHub, Wger, Habitica, D1, etc.)
```

## Estrutura do repositório

Cada Worker mora na sua própria subpasta, com seu próprio `wrangler.toml`:

```
cloudflare-mcp/
├── README.md           ← este arquivo
├── git/                ← MCP do GitHub — ver git/README.md
│   ├── README.md
│   ├── wrangler.toml
│   └── worker.js
├── wger/               ← MCP do Wger — ver wger/README.md
│   ├── README.md
│   ├── wrangler.toml
│   └── worker.js
├── habitica/           ← MCP do Habitica — ver habitica/README.md
│   ├── README.md
│   ├── wrangler.toml
│   └── worker.js
├── memoria/            ← MCP de memória em grafo (D1) — ver memoria/README.md
│   ├── README.md
│   ├── wrangler.toml
│   └── worker.js
└── comm/               ← Hub de comunicação (Telegram + monitor de rede local) — ver comm/README.md
    ├── README.md
    ├── wrangler.toml
    └── worker.js
```

Um novo serviço = uma nova subpasta com a mesma estrutura e um novo Worker no Cloudflare
conectado a ela via **Build > Git repository**, com **Root directory** apontando para a subpasta.

## Deploy automático

Cada Worker está conectado a este repositório via **Cloudflare Workers Builds**. Um push na
`main` dentro da subpasta do Worker dispara build e deploy automaticamente.

## Servidores neste repositório

| Pasta | Worker | Tipo | Maturidade | O que faz |
|---|---|---|---|---|
| [`git/`](./git) | `mcp-git` | MCP | Estável | Leitura e escrita em repositórios do GitHub — arquivos, branches, PRs, issues e Actions |
| [`wger/`](./wger) | `mcp-wger` | MCP | Estável | Leitura e escrita na API do Wger (wger.de) — treino, peso e nutrição |
| [`habitica/`](./habitica) | `mcp-habitica` | MCP | Estável | Leitura e escrita na API do Habitica (habitica.com) — hábitos, dailies, to-dos |
| [`memoria/`](./memoria) | `mcp-memoria` | MCP | Estável | Grafo de memória pessoal persistido em Cloudflare D1 — ferramentas MCP e API REST |
| [`comm/`](./comm) | `comm` | Webhook | Em desenvolvimento | Hub de comunicação via Telegram, com monitor de rede local (dead man's switch) — não é um MCP |

**Escala de maturidade:**

- **Estável** — em uso pessoal contínuo, sem incidentes conhecidos.
- **Beta** — funcional e em uso, mas com limitações conhecidas registradas no README da pasta.
- **Em desenvolvimento** — funcionando, mas ainda evoluindo ativamente (rotas, comandos ou
  recursos novos sendo adicionados).

Detalhes de cada Worker, incluindo tabela de ferramentas/rotas e passo a passo de configuração,
estão no `README.md` da respectiva pasta.

## Segurança

- PATs do GitHub são **fine-grained**, escopados ao mínimo necessário.
- Secrets do Worker são sempre marcados como `Secret` (criptografado), nunca `Plaintext`.
- Toda ferramenta MCP exposta ao Claude fica configurada como **"Requer aprovação"** no
  conector — nada executa sem confirmação explícita antes de cada chamada.
- Workers que não são MCPs (como o `comm`) autenticam quem os chama por secret direto
  (Bearer token ou secret de webhook), sem OAuth, por não haver um custom connector do Claude
  envolvido.

## Por que Cloudflare Workers

A escolha da plataforma foi orientada por dois critérios: **sem custo** e **sem servidor
dedicado**.

**Sem servidor dedicado.** Os Workers rodam na infraestrutura do Cloudflare, sempre disponíveis,
sem depender de um computador local ligado ou de uma conexão doméstica estável.

**Sem cartão de crédito.** O cadastro na Cloudflare é gratuito e não exige dados de pagamento.
O free tier cobre com folga qualquer uso pessoal:

| Recurso | Limite gratuito |
|---|---|
| Cloudflare Workers | 100.000 requisições / dia |
| Cloudflare D1 (banco SQLite) | 5 GB storage · 5 M leituras/dia · 100 K escritas/dia |
| Cloudflare KV | 100.000 leituras/dia · 1.000 escritas/dia |
| Workers Builds (deploy automático) | Incluído, conectado ao GitHub |
| Domínio customizado | Incluído para domínios já gerenciados na Cloudflare |

**HTTPS automático.** Qualquer Worker com domínio próprio ganha certificado SSL sem configuração
adicional.

**Deploy pelo GitHub.** Um `git push` já atualiza o Worker em produção — sem CLI, sem copiar
código manualmente no painel.

**Sem cold starts.** Diferente de plataformas com free tiers que dormem por inatividade (Railway,
Render), Workers respondem imediatamente a qualquer hora.
