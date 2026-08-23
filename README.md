# cloudflare-mcp

Uma coleção de servidores MCP (Model Context Protocol) simples para **uso pessoal**, rodando
em Cloudflare Workers. O objetivo é dar ao Claude acesso de leitura e escrita real a serviços
que o conector oficial do Claude não cobre, ou só cobre em modo leitura — sem precisar de
servidor próprio, sem custo de infraestrutura e sem cartão de crédito.

## Por que Cloudflare Workers

A proposta desta coleção é que qualquer pessoa consiga rodar seus próprios MCPs de graça, sem
manter nada localmente. Cloudflare Workers é a plataforma que torna isso viável:

**Sem servidor dedicado.** Não precisa de um Raspberry Pi ligado em casa, de uma VPS paga, nem
de um processo rodando em segundo plano no seu computador. Os Workers ficam na infraestrutura
do Cloudflare, sempre disponíveis, independentemente de o seu computador estar ligado ou a sua
internet doméstica estar estável.

**Sem cartão de crédito.** A conta Cloudflare é gratuita e o cadastro não exige dados de
pagamento. O Workers free tier cobre com folga qualquer uso pessoal:

| Recurso | Limite gratuito |
|---|---|
| Cloudflare Workers | 100.000 requisições / dia |
| Cloudflare D1 (banco SQLite) | 5 GB de storage · 5 M leituras / dia · 100 K escritas / dia |
| Workers Builds (deploy automático) | Incluído, conectado ao GitHub |
| Domínio customizado | Incluído se o domínio já estiver na Cloudflare |

Para referência: um MCP pessoal dificilmente vai passar de algumas centenas de requisições por
dia. Os limites acima são ordens de grandeza maiores do que o uso real.

**Deploy automático pelo GitHub.** Cada Worker está conectado a uma subpasta deste repositório.
Um `git push` na `main` já dispara o build e o deploy — sem CLI, sem painel manual, sem copiar
e colar código. O fluxo de atualizar um Worker é: editar o `worker.js`, commitar, pronto.

**HTTPS e SSL automáticos.** Qualquer Worker com domínio próprio ganha certificado SSL
automaticamente, sem Let's Encrypt manual nem renovações para acompanhar.

**Zero dependências de build.** Cada Worker é um arquivo JavaScript único, sem npm, sem
bundler, sem etapa de compilação. O próprio runtime do Workers suporta tudo que é usado aqui
(`fetch`, `crypto.subtle`, `TextEncoder`). Isso mantém o código auditável e o deploy simples.

**Escalabilidade automática.** O Worker responde em múltiplas regiões simultaneamente, sem
configuração. Para uso pessoal isso não importa muito, mas significa também que não há cold
starts nem timeouts de inatividade como nos free tiers de plataformas como Railway ou Render.

## Por que isso existe

O conector oficial do GitHub no claude.ai é **só leitura** — o token OAuth que ele usa não tem
permissão de escrita, mesmo autorizando escopos de `Contents`. Isso foi testado e confirmado
(erro `403 Resource not accessible by integration`), inclusive desautorizando e reconectando o
conector do zero. Não é uma questão de configuração do usuário.

Custom connectors do claude.ai (o mecanismo para plugar um servidor MCP remoto próprio) também
não permitem mandar headers customizados (tipo `Authorization: Bearer <token>`), então não dá
para simplesmente apontar para a API do GitHub direto com um Personal Access Token.

A saída: um Worker próprio no Cloudflare que funciona como uma ponte. Ele guarda o token de
verdade como *secret* do lado do servidor, expõe uma URL MCP simples que o Claude acessa sem
precisar de headers especiais, e por dentro conversa com a API de cada serviço usando as
credenciais certas.

## Ideia geral / arquitetura

- Cada serviço (GitHub, Wger, Memória, e no futuro outros) vira **um Worker separado**, com seu
  próprio subdomínio: `mcp-<servico>.<seu-dominio>`.
- Cada Worker é **um arquivo único de JavaScript**, sem build step, sem dependências de npm.
  Só usa `fetch` nativo do runtime do Workers. Isso mantém o deploy simples e o código fácil de
  auditar.
- Autenticação é feita por **OAuth 2.1 com PKCE** (padrão do `mcp-wger` e `mcp-memoria`) ou por
  **segredo na URL** (padrão legado do `mcp-git`). Em ambos os casos, as credenciais de acesso
  aos serviços externos ficam como **secrets do Worker no Cloudflare** — nunca no código.
- Cada Worker implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP) na mão: `initialize`,
  `tools/list` e `tools/call`. Não usa nenhum SDK.

```
Claude (custom connector)
   │  HTTPS POST /mcp  (JSON-RPC, Bearer JWT)
   ▼
Cloudflare Worker (mcp-<servico>.<seu-dominio>)
   │  usa secret PAT/API key/D1 binding
   ▼
API do serviço ou banco de dados (GitHub, Wger, D1, etc.)
```

## Estrutura do repositório

Cada Worker mora na sua própria subpasta, com seu próprio `wrangler.toml`:

```
cloudflare-mcp/
├── README.md           ← este arquivo (visão geral)
├── git/                ← MCP do GitHub — ver git/README.md
│   ├── README.md
│   ├── wrangler.toml
│   └── worker.js
├── wger/               ← MCP do Wger — ver wger/README.md
│   ├── README.md
│   ├── wrangler.toml
│   └── worker.js
└── memoria/            ← MCP de memória em grafo (D1) — ver memoria/README.md
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
| [`git/`](./git) | `mcp-git` | `mcp-git.<seu-dominio>` | Leitura e escrita em repositórios do GitHub (arquivos, commits, branches e pull requests) |
| [`wger/`](./wger) | `mcp-wger` | `mcp-wger.<seu-dominio>` | Leitura e escrita na API do Wger (wger.de) — treino, peso, nutrição |
| [`memoria/`](./memoria) | `mcp-memoria` | `mcp-memoria.<seu-dominio>` | Grafo de memória pessoal persistido em Cloudflare D1 — ferramentas MCP + API REST |

Detalhes de cada um, incluindo passo a passo de configuração, estão no `README.md` da respectiva
pasta.

## Regras de segurança seguidas na configuração

- Nenhum token ou segredo é digitado por IA em campo nenhum — quem cola as credenciais é sempre
  a pessoa dona da conta.
- PATs do GitHub são **fine-grained**, escopados ao mínimo necessário, nunca *classic tokens*.
- Secrets do Worker são sempre marcados como `Secret` (criptografado), nunca `Plaintext`.
- Toda ferramenta exposta ao Claude fica configurada como **"Requer aprovação"** no conector,
  então nada roda sem confirmação explícita antes de cada chamada.
- O domínio real usado nos Workers não é citado nesta documentação — cada instalação usa o
  próprio domínio do dono da conta Cloudflare.
