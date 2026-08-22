# cloudflare-mcp

Servidores MCP (Model Context Protocol) próprios, rodando em Cloudflare Workers, para dar ao
Claude acesso de **leitura e escrita real** a serviços que o conector oficial do Claude não
cobre ou só cobre em modo leitura.

## Por que isso existe

O conector oficial do GitHub no claude.ai é **só leitura** — o token OAuth que ele usa não tem
permissão de escrita, mesmo autorizando escopos de `Contents`. Isso foi testado e confirmado
(erro `403 Resource not accessible by integration`), inclusive desautorizando e reconectando o
conector do zero. Não é uma questão de configuração do usuário.

Custom connectors do claude.ai (o mecanismo para plugar um servidor MCP remoto próprio) também
não permitem mandar headers customizados (tipo `Authorization: Bearer <token>`), então não dá
para simplesmente apontar para a API do GitHub direto com um Personal Access Token.

A saída: um Worker próprio no Cloudflare que funciona como uma ponte. Ele guarda o token de
verdade como *secret* do lado do servidor, expõe uma URL MCP simples (`/<segredo>/mcp`) que o
Claude acessa sem precisar de headers especiais, e por dentro conversa com a API de cada serviço
usando as credenciais certas.

## Ideia geral / arquitetura

- Cada serviço (GitHub, e no futuro outros — Wger, etc.) vira **um Worker separado**, com seu
  próprio subdomínio: `mcp-<servico>.alexcordeiro.dev`.
- Cada Worker é **um arquivo único de JavaScript**, sem build step, sem dependências de npm.
  Só usa `fetch` nativo do runtime do Workers. Isso mantém o deploy simples e o código fácil de
  auditar.
- Autenticação é feita por um **segredo na própria URL**: `https://mcp-<servico>.alexcordeiro.dev/<MCP_SECRET>/mcp`.
  Sem esse segredo no path, o Worker responde `401 Unauthorized`. É um esquema simples porque o
  custom connector do Claude não suporta headers customizados — então o segredo tem que viajar
  na URL.
- As credenciais de verdade (tokens de API de cada serviço) ficam como **secrets do Worker no
  Cloudflare** (`Settings > Variables and Secrets`, tipo `Secret`, nunca `Plaintext`). Elas nunca
  aparecem no código nem no repositório.
- Cada Worker implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP) na mão: `initialize`,
  `tools/list` e `tools/call`. Não usa nenhum SDK — é só o suficiente pra falar com o Claude.

```
Claude (custom connector)
   │  HTTPS POST /<MCP_SECRET>/mcp  (JSON-RPC)
   ▼
Cloudflare Worker (mcp-<servico>.alexcordeiro.dev)
   │  usa secret PAT/API key do Worker
   ▼
API do serviço (GitHub, etc.)
```

## Estrutura do repositório

Cada Worker mora na sua própria subpasta, com seu próprio `wrangler.toml`:

```
cloudflare-mcp/
├── README.md          ← este arquivo (visão geral)
└── git/                ← MCP do GitHub — ver git/README.md
    ├── README.md
    ├── wrangler.toml
    └── worker.js
```

Um novo serviço = uma nova subpasta com a mesma estrutura (`README.md`, `wrangler.toml`,
`worker.js`) e um novo Worker no Cloudflare conectado a essa subpasta (via
**Build > Git repository**, com **Root directory** apontando pra ela).

## Deploy automático

Cada Worker está conectado a este repositório via a integração nativa do Cloudflare
(**Workers Builds**). Um push na `main`, dentro da subpasta daquele Worker, dispara build e
deploy automáticos — não precisa colar código manualmente no painel depois da configuração
inicial.

## Servidores MCP neste repositório

| Pasta | Worker | Domínio | O que faz |
|---|---|---|---|
| [`git/`](./git) | `mcp-git` | `mcp-git.alexcordeiro.dev` | Leitura e escrita em repositórios do GitHub (arquivos, commits) |

Detalhes de cada um, incluindo passo a passo de configuração, estão no `README.md` da respectiva
pasta.

## Regras de segurança seguidas na configuração

- Nenhum token ou segredo é digitado por IA em campo nenhum — quem cola as credenciais é sempre
  a pessoa dona da conta.
- PATs do GitHub são **fine-grained**, escopados ao mínimo necessário (`Contents: Read and
  write`), nunca *classic tokens* com acesso total.
- Secrets do Worker são sempre marcados como `Secret` (criptografado), nunca `Plaintext`.
- Toda ferramenta exposta ao Claude fica configurada como **"Requer aprovação"** no conector,
  então nada roda sem confirmação explícita antes de cada chamada.
