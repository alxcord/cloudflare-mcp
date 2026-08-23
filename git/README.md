# mcp-git

Servidor MCP que dá ao Claude leitura e **escrita real** em repositórios do GitHub, contornando
a limitação do conector oficial (que é só leitura). Roda como Cloudflare Worker, arquivo único,
sem build.

- Worker: `mcp-git`
- Domínio: `https://mcp-git.<seu-dominio>`
- Rota MCP: `https://mcp-git.<seu-dominio>/mcp` (autenticada por **OAuth 2.1 + PKCE**)
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)

## Por que este Worker existe

O conector oficial do GitHub no claude.ai é **só leitura** — o token OAuth que ele usa não tem
permissão de escrita, mesmo autorizando escopos de `Contents`. Isso foi testado e confirmado
(erro `403 Resource not accessible by integration`), inclusive desautorizando e reconectando o
conector do zero. Não é uma questão de configuração.

Custom connectors do claude.ai também não permitem enviar headers customizados, então não é
possível simplesmente apontar para a API do GitHub com um Personal Access Token no header de
Autorização. A solução é um Worker intermediário: ele armazena o PAT como secret do lado do
servidor, expõe um endpoint MCP sem headers especiais, e por dentro autentica na API do GitHub
usando o token real.

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP — `initialize`, `tools/list`, `tools/call`)
e expõe 27 ferramentas que chamam a API REST do GitHub usando um Personal Access Token guardado
como secret do Worker.

### Arquivos e commits

| Ferramenta | O que faz |
|---|---|
| `whoami` | Retorna o usuário do GitHub autenticado pelo token configurado |
| `list_dir` | Lista arquivos e pastas de um diretório de um repositório |
| `read_file` | Lê o conteúdo de um arquivo |
| `write_file` | Cria ou atualiza um único arquivo (um commit) |
| `push_files` | Cria ou atualiza vários arquivos em um único commit (usa a Git Trees API) |
| `delete_file` | Apaga um arquivo |

### Branches

| Ferramenta | O que faz |
|---|---|
| `list_branches` | Lista as branches, com SHA do último commit e marcação de qual é a default |
| `create_branch` | Cria uma branch a partir de outra branch ou de um SHA (padrão: a branch default) |
| `delete_branch` | Apaga uma branch remota — recusa apagar a branch default |

### Pull requests

| Ferramenta | O que faz |
|---|---|
| `list_pull_requests` | Lista PRs abertos, fechados ou todos, com filtro por `base`/`head` |
| `get_pull_request` | Detalhes de um PR: descrição, estado, `mergeable`, arquivos alterados |
| `get_pull_request_diff` | Diff unificado do PR, truncado em 60.000 caracteres por padrão |
| `create_pull_request` | Abre um PR (aceita `draft`; `base` padrão é a branch default) |
| `update_pull_request` | Altera título, descrição, branch base ou estado (`open`/`closed`) |
| `merge_pull_request` | Faz o merge — método `merge`, `squash` (padrão) ou `rebase` |
| `comment_pull_request` | Comentário geral na conversa do PR |
| `review_pull_request` | Revisão formal: `COMMENT`, `APPROVE` ou `REQUEST_CHANGES`, com comentários em linhas específicas do diff |

### Issues

| Ferramenta | O que faz |
|---|---|
| `list_issues` | Lista issues abertas, fechadas ou todas, com filtro por `labels`. Nunca inclui PRs |
| `get_issue` | Detalhes de uma issue: descrição, estado, labels, responsaveis |
| `create_issue` | Abre uma issue nova, com `labels` e `assignees` opcionais |
| `update_issue` | Altera título, descrição, estado, labels ou responsaveis |
| `comment_issue` | Comentário na conversa da issue |

### Actions (read-only)

| Ferramenta | O que faz |
|---|---|
| `list_workflow_runs` | Lista execuções de workflow, com filtro por `workflow`, `branch`, `status` |
| `get_workflow_run` | Detalhes de uma execução: status, conclusão, branch, commit |
| `list_workflow_run_jobs` | Jobs de uma execução, com os steps individuais e onde falhou |

### Pages (read-only)

| Ferramenta | O que faz |
|---|---|
| `get_pages_site` | Configuração publicada: URL, status, source (branch/pasta), domínio customizado |
| `get_pages_build_status` | Status do último build/deploy — sucesso, erro (com mensagem) ou construíndo |

Todas as ferramentas recebem `owner` e `repo` como parâmetros — não é um MCP amarrado a um
repositório específico, funciona com qualquer repositório que o token tenha permissão de acessar.

Diferente do `mcp-wger` (que expõe ferramentas genéricas de REST — `api_get`, `api_post`, etc.),
aqui cada operação tem sua própria ferramenta: a parte da API do GitHub usada é pequena, estável
e bem conhecida, e algumas operações não são uma chamada só (o `push_files` orquestra cinco
chamadas encadeadas da Git Trees API para caber tudo em um commit).

> `comment_pull_request` e `comment_issue` chamam o mesmo endpoint do GitHub por baixo (comentários
> de PR e de issue são a mesma coisa na API) — ficam como ferramentas separadas porque o
> vocabulário de cada recurso é diferente e evita confundir o Claude sobre qual número está
> comentando.

## Fluxo típico com branch e PR

As ferramentas de escrita em arquivo (`write_file`, `push_files`, `delete_file`) aceitam o
parâmetro `branch`, então o ciclo completo é feito só com este MCP:

1. `create_branch` — cria `feat/alguma-coisa` a partir da branch default.
2. `push_files` com `branch: 'feat/alguma-coisa'` — commita as mudanças **na branch nova**.
   Sem passar `branch` explicitamente, o padrão continua sendo `main` e o commit vai direto pra
   linha principal.
3. `create_pull_request` com `head: 'feat/alguma-coisa'` — abre o PR.
4. `get_pull_request_diff` — revisa o que mudou de fato.
5. `merge_pull_request` e depois `delete_branch` — fecha o ciclo.

Para acompanhar o deploy depois do merge (ex: neste próprio repositório, onde os Workers têm
build automático), `list_workflow_runs` com `branch: 'main'` mostra a execução mais recente, e
`list_workflow_run_jobs` mostra onde falhou, se falhou. Para repositórios com GitHub Pages
servido via Jekyll clássico (não via Actions), `get_pages_build_status` é o equivalente.

## Autenticação

Duas camadas:

1. **Claude → Worker**: OAuth 2.1 com PKCE. O Claude segue o fluxo padrão de *authorization
   code*: abre `/authorize` no navegador, você aprova colando o `MCP_SECRET` uma única vez (na
   hora de vincular o conector), o Worker devolve um código de uso único, o Claude troca esse
   código por um **access token Bearer** em `/token`, e passa a usar
   `Authorization: Bearer <token>` em toda chamada a `/mcp` daí em diante. O token expira em 30
   dias; depois disso o Claude repete o fluxo automaticamente.
2. **Worker → GitHub**: o Worker autentica na API do GitHub com um Personal Access Token
   fine-grained, guardado como secret `PAT`, mandado no header `Authorization: Bearer <valor>`.

Os dois secrets (`MCP_SECRET` e `PAT`) ficam só no Cloudflare, criptografados. Nunca aparecem no
código deste repositório.

### Como a autenticação OAuth funciona por dentro (sem banco de dados)

Não há banco, KV nem Durable Object — tudo é **stateless**, usando JWTs (HS256) assinados com o
`MCP_SECRET` via `crypto.subtle` nativo do Workers:

- O "código de autorização" emitido por `/authorize` é ele mesmo um JWT de vida curta (60s),
  carregando o `redirect_uri` e o `code_challenge` (PKCE) dentro de si, assinado.
- `/token` valida a assinatura, confere o PKCE (`code_verifier` batendo com o `code_challenge`
  original) e emite outro JWT como access token, válido por 30 dias.
- `/mcp` só precisa validar a assinatura e a validade do JWT recebido — não consulta nada
  guardado em lugar nenhum.
- **Não dá para revogar um token individual antes de expirar.** Para invalidar tudo de uma vez,
  troque o valor de `MCP_SECRET` no Cloudflare — isso invalida instantaneamente qualquer código
  ou token já emitido.
- Não há registro dinâmico de cliente (`/register` do RFC 7591): o campo **OAuth Client ID** no
  custom connector do Claude é preenchido manualmente com um valor fixo.

Rotas expostas pelo Worker:

| Rota | Método | O que faz |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | Metadata OAuth (endpoints, `S256`, `grant_types`) |
| `/authorize` | GET | Tela de aprovação — pede o `MCP_SECRET` e devolve o código |
| `/token` | POST | Troca código + `code_verifier` por access token |
| `/mcp` | POST | Endpoint MCP, exige `Authorization: Bearer <token>` |

### Sobre o PAT do GitHub

O secret `PAT` é um fine-grained token, com as permissões de repositório:

| Permissão | Nível | Para quê |
|---|---|---|
| `Metadata` | Read-only | Obrigatória, marcada automaticamente |
| `Contents` | Read and write | Arquivos, commits e branches (a Git Refs API cai neste escopo) |
| `Pull requests` | Read and write | Abrir, atualizar, comentar, revisar e mergear PRs |
| `Issues` | Read and write | Abrir, atualizar e comentar issues |
| `Actions` | Read-only | Consultar execuções de workflow, jobs e steps |
| `Pages` | Read-only | Consultar configuração do site e status do último build |

Se o token vazar, a forma de invalidar é revogá-lo em
[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)
e gerar outro; trocar o `MCP_SECRET` corta o acesso do Claude ao Worker, mas não invalida o PAT.

## Passo a passo de configuração do zero

### 1. Criar o Personal Access Token no GitHub

1. Acesse [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Dê um nome (ex: `MCP Worker - GitHub`).
3. Em **Expiration**, escolha o prazo desejado.
4. Em **Repository access**, escolha `Only select repositories` e selecione só os repositórios
   necessários, ou `All repositories` se o MCP precisar escrever em vários repos.
5. Em **Permissions > Repository permissions**, defina `Contents: Read and write`,
   `Pull requests: Read and write`, `Issues: Read and write`, `Actions: Read-only` e
   `Pages: Read-only`. `Metadata: Read-only` é marcado automaticamente.
6. Clique em **Generate token** e copie o valor — o GitHub só mostra uma vez.

> Para adicionar permissões a um token já existente, abra-o em
> [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens),
> marque as permissões novas e salve. O valor do token não muda.

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!**.
3. Dê o nome: `mcp-git`.
4. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository** e clique em **GitHub**.
2. Autorize o app **Cloudflare Workers and Pages** no GitHub, marcando só este repositório
   (`cloudflare-mcp`).
3. De volta no Cloudflare:
   - Repository: `cloudflare-mcp`
   - Production branch: `main`
   - Em **Advanced settings > Path**, defina `/git`.
4. Clique em **Connect**.

### 4. Configurar os secrets do Worker

Em **Settings > Variables and Secrets > Add variable**, adicione:

- `PAT` — o token gerado no passo 1. Marcar como **Secret**.
- `MCP_SECRET` — string longa e aleatória. Marcar como **Secret**.

### 5. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Defina o subdomínio `mcp-git` na mesma zona dos outros Workers.
3. O Cloudflare emite o certificado SSL automaticamente.

### 6. Testar antes de conectar ao Claude

```bash
# Metadata OAuth deve retornar 200
curl https://mcp-git.<seu-dominio>/.well-known/oauth-authorization-server

# /mcp sem token deve retornar 401
curl -X POST https://mcp-git.<seu-dominio>/mcp
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: `MCP Git` (ou qualquer nome).
3. **URL do servidor MCP remoto**: `https://mcp-git.<seu-dominio>/mcp`.
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo (ex: `claude-git`).
   Deixe **Client Secret** vazio.
5. Clique em **Adicionar** e depois em **Vincular**. Cole o `MCP_SECRET` na tela de aprovação.
6. Confirme que todas as ferramentas ficam com **"Requer aprovação"**.

### 8. Validar

Peça ao Claude chamar `whoami`. Deve retornar o `login`, `name` e `id` da conta do GitHub dona
do token. Para validar cada bloco de ferramentas: `list_pull_requests`, `list_issues`,
`list_workflow_runs` e `get_pages_site` em qualquer repo cobrem todas as permissões do PAT.

## Atualizando o código

Edite `worker.js` e faça push na `main`. O Cloudflare Workers Builds detecta o commit e faz o
deploy automaticamente.

Depois que o deploy sobe com ferramentas novas, o Claude não as enxerga na sessão em andamento —
a lista de ferramentas é lida no handshake inicial. Abra uma conversa nova ou recarregue o
conector para as ferramentas novas aparecerem.

**Cuidado com a auto-referência**: o próprio `mcp-git` é usado para escrever neste repositório.
Qualquer mudança que quebre a autenticação derruba, no mesmo deploy, a ferramenta que estava
fazendo a mudança. Um `node --check worker.js` antes do push evita a classe mais comum de quebra
(erro de sintaxe).

## Limitações conhecidas

- `push_files` cria um commit a partir do `HEAD` da branch no momento da chamada; não faz merge
  de conflitos — se o arquivo mudou entre a leitura e a escrita, o commit pode sobrescrever
  mudanças concorrentes.
- `write_file`, `push_files` e `delete_file` usam `main` como branch padrão quando `branch` não
  é informado. Em um fluxo de PR, passar a branch explicitamente é obrigatório.
- `review_pull_request` com `event: 'APPROVE'` falha com `422` quando o autor do PR é o mesmo
  usuário do PAT — o GitHub não deixa ninguém aprovar o próprio PR.
- `list_workflow_runs` sem `workflow` lista execuções de todos os workflows do repo.
- `get_pages_site` e `get_pages_build_status` respondem `404` em repositórios sem GitHub Pages
  habilitado.
- `get_pages_build_status` reflete o build clássico do Pages. Sites que publicam via workflow do
  Actions devem usar `list_workflow_runs`.
- Branches protegidas continuam protegidas: `merge_pull_request` respeita as regras do
  repositório e falha com `405` se elas não forem atendidas.
- `get_pull_request_diff` trunca o diff (padrão 60.000 caracteres).
- `push_files` e `write_file` não servem para arquivos binários.
- Access tokens não podem ser revogados individualmente — só trocando o `MCP_SECRET`.
- `/authorize` aplica um delay de 2s em tentativas de senha incorretas, dificultando força bruta,
  mas não impede flood de requisições (DoS por volume). Para proteção adicional, ative o
  **Bot Fight Mode** em **Security > Bots** no painel do Cloudflare.
