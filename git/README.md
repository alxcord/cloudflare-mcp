# mcp-git

Servidor MCP que dá ao Claude leitura e **escrita real** em repositórios do GitHub, contornando
a limitação do conector oficial (que é só leitura). Roda como Cloudflare Worker, arquivo único,
sem build.

- Worker: `mcp-git`
- Domínio: `https://mcp-git.<seu-dominio>`
- Rota MCP: `https://mcp-git.<seu-dominio>/mcp` (autenticada por **OAuth 2.1 + PKCE**, não por
  segredo na URL — ver [Autenticação](#autenticação))
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)

> Este Worker nasceu com o segredo embutido na URL (`/<MCP_SECRET>/mcp`) e foi migrado para
> OAuth depois, seguindo o mesmo padrão já validado no [`mcp-wger`](../wger). Ver
> [Por que OAuth em vez de segredo na URL](#por-que-oauth-em-vez-de-segredo-na-url).

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
- **Não dá para revogar um token individual antes de expirar.** Se precisar invalidar tudo de
  uma vez (token vazado, por exemplo), a forma é trocar o valor de `MCP_SECRET` no Cloudflare —
  isso invalida instantaneamente qualquer código ou token já emitido, porque a assinatura deles
  deixa de bater.
- Não há registro dinâmico de cliente (`/register` do RFC 7591): o campo **OAuth Client ID** no
  custom connector do Claude é preenchido manualmente com um valor fixo (o Worker aceita
  qualquer string ali, não valida contra uma lista).

Rotas expostas pelo Worker:

| Rota | Método | O que faz |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | Metadata OAuth (endpoints, `S256`, `grant_types`) |
| `/authorize` | GET | Tela de aprovação — pede o `MCP_SECRET` e devolve o código |
| `/token` | POST | Troca código + `code_verifier` por access token |
| `/mcp` | POST | Endpoint MCP, exige `Authorization: Bearer <token>` |

### Por que OAuth em vez de segredo na URL

HTTPS já criptografa a requisição inteira (path incluído), então um segredo na URL não é "visível
na rede" — o risco real é outro: URLs tendem a ficar gravadas em lugares que headers não
alcançam (histórico de navegador, logs de acesso de servidores/proxies, header `Referer` se a
página disparar alguma requisição pra fora, prints de tela, ou coladas no campo errado — já
aconteceu aqui de um gerenciador de senhas colar uma referência interna em vez do valor puro).
Um Bearer token no header não sofre esses vazamentos de superfície.

O ganho prático de migrar: o `MCP_SECRET` deixa de ser transmitido em **toda chamada, para
sempre** — ele agora é digitado **uma única vez**, na tela de aprovação, no momento de vincular o
conector. Depois disso, quem trafega em cada chamada é um token de vida limitada (30 dias), que
nunca aparece em uma URL. No caso específico deste Worker o ganho pesa mais que no `mcp-wger`,
porque o `PAT` que ele guarda dá escrita em **todos** os repositórios da conta.

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
2. Dê um nome (ex: `MCP Worker - <finalidade>`).
3. Em **Expiration**, escolha o prazo (o Cloudflare permite `No expiration`, mas o GitHub avisa
   que não é o ideal em termos de segurança — considere um prazo definido e renovar depois).
4. Em **Repository access**, escolha:
   - `Only select repositories` e selecione só os repositórios que esse MCP vai precisar, **ou**
   - `All repositories`, se o MCP precisa escrever em vários repos (ex: site pessoal + vault do
     Obsidian).
5. Em **Permissions > Repository permissions**, defina `Contents: Read and write`,
   `Pull requests: Read and write`, `Issues: Read and write`, `Actions: Read-only` e
   `Pages: Read-only`. `Metadata: Read-only` é marcado automaticamente (obrigatório).
6. Clique em **Generate token** e copie o valor imediatamente — o GitHub só mostra uma vez.

> Para adicionar permissões novas a um token que **já existe**, não é preciso gerar outro: abra
> o token em
> [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens),
> marque as permissões novas e salve. O valor do token não muda, então o secret `PAT` no
> Cloudflare continua válido.

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!** para começar com um Worker de arquivo único editável
   direto no painel.
3. Dê o nome ao Worker (ex: `mcp-git`). **Atenção**: o nome não pode ser mudado depois pelo
   editor de código, só em **Settings > General > Name** (renomeia o Worker, mas não muda a URL
   `*.workers.dev` já gerada).
4. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository** e clique em **GitHub**.
2. Autorize o app **Cloudflare Workers and Pages** no GitHub, escolhendo **Only select
   repositories** e marcando só este repositório (`cloudflare-mcp`) — evita dar acesso a todos
   os repos da conta para o app do Cloudflare.
3. De volta no Cloudflare, em **Connect to a repository**:
   - Repository: `cloudflare-mcp`
   - Production branch: `main`
   - Em **Advanced settings > Path**, defina `/git` (a subpasta deste Worker dentro do
     monorepo).
   - Deploy command: `npx wrangler deploy` (padrão).
4. Clique em **Connect**. Um push nessa subpasta já dispara build e deploy automáticos daqui
   pra frente.

### 4. Configurar os secrets do Worker

1. Em **Settings > Variables and Secrets > Add variable**, adicione:
   - `PAT` — o token gerado no passo 1. Marcar como **Secret**.
   - `MCP_SECRET` — uma string longa e aleatória (ex: gerada com um gerenciador de senhas).
     Marcar como **Secret**. Ela não vai na URL: serve como senha da tela de aprovação e como
     chave de assinatura dos tokens OAuth.
2. Salve. Não precisa redeploy manual — o Worker lê os secrets em runtime.

### 5. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Escolha uma zona sua no Cloudflare e defina o subdomínio (ex: `mcp-git`).
3. O Cloudflare emite certificado SSL automaticamente. Em poucos minutos o Worker responde em
   `https://mcp-git.<seu-dominio>`.

> O domínio precisa bater com a constante `ISSUER` no topo do `worker.js` — ela é o `issuer`
> anunciado na metadata OAuth e é usada para montar os endpoints `/authorize` e `/token`. Se
> mudar o domínio, mude a constante junto.

### 6. Testar antes de conectar ao Claude

A metadata OAuth deve responder normalmente:

```
GET https://mcp-git.<seu-dominio>/.well-known/oauth-authorization-server
→ 200, JSON com authorization_endpoint e token_endpoint
```

Sem Bearer token, `/mcp` deve responder `401`:

```
POST https://mcp-git.<seu-dominio>/mcp
→ 401, {"error":"invalid_token", ...}
```

E a rota antiga, com o segredo no path, não existe mais:

```
POST https://mcp-git.<seu-dominio>/<MCP_SECRET>/mcp
→ 404 Not found
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: algo identificável só para você (ex: `MCP Git`) — não é preciso incluir o domínio
   no nome do conector.
3. **URL do servidor MCP remoto**: `https://mcp-git.<seu-dominio>/mcp` (sem segredo nenhum na
   URL). **Confira visualmente antes de confirmar** que o campo tem só a URL — um gerenciador de
   senhas às vezes cola uma referência interna em vez do texto puro.
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo qualquer (ex:
   `claude-git`) — evita que o Claude tente se auto-registrar via um endpoint que este Worker
   não implementa. Deixe **Client Secret** vazio (é um fluxo PKCE, não precisa).
5. Clique em **Adicionar** e depois em **Vincular**. Isso abre `/authorize` — cole o
   `MCP_SECRET` configurado no passo 4 e clique em **Aprovar**. O Claude troca o código pelo
   access token automaticamente nos bastidores.
6. Depois de vinculado, em **Permissões de ferramentas**, todas as ferramentas vêm com
   **"Requer aprovação"** por padrão — nada executa sem confirmação manual antes de cada chamada.
   Vale conferir que as ferramentas destrutivas (`delete_file`, `delete_branch`,
   `merge_pull_request`) estão nesse modo.

### 8. Validar

Peça pro Claude chamar a ferramenta `whoami`. Deve retornar o `login`, `name` e `id` da conta do
GitHub dona do token — confirmando que a cadeia completa (Claude → OAuth → Worker → GitHub) está
funcionando. Para validar o bloco de PRs, `list_pull_requests` em qualquer repo é o teste mais
barato: se o PAT estiver sem a permissão de Pull requests, ele responde `403`. O mesmo vale para
`list_issues` (Issues), `list_workflow_runs` (Actions) e `get_pages_site` (Pages).

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) neste repositório e dar push na `main`. O
Cloudflare Workers Builds detecta o commit, builda e faz o deploy automaticamente — sem precisar
colar código manualmente no editor do painel.

Depois que o deploy sobe com ferramentas novas, o Claude **não** as enxerga automaticamente na
sessão em andamento: a lista de ferramentas é lida no `tools/list` do handshake. É preciso
recarregar a conexão (desligar e religar o conector, ou abrir uma conversa nova) para as
ferramentas novas aparecerem.

**Cuidado com a auto-referência**: como é o próprio `mcp-git` que costuma escrever neste repo,
qualquer mudança que quebre a autenticação deste Worker derruba, no mesmo deploy, a ferramenta
que estava fazendo a mudança. Foi o que aconteceu na migração para OAuth: o commit precisou sair
inteiro de uma vez (`push_files`), e o conector só voltou a funcionar depois de reconfigurado à
mão no claude.ai. Mudanças assim exigem revisão antes do push, porque não dá para testar o
endpoint novo sem já ter desligado o antigo. Um `node --check` no arquivo antes do push evita a
classe mais boba de quebra (erro de sintaxe derrubando o build).

## Limitações conhecidas

- `push_files` cria um novo commit a partir do `HEAD` da branch no momento da chamada; não
  faz merge de conflitos — se o arquivo mudou entre a leitura e a escrita, o commit pode
  sobrescrever mudanças concorrentes.
- `write_file`, `push_files` e `delete_file` usam `main` como branch padrão quando `branch` não é
  informado. Em um fluxo de PR, passar a branch explicitamente é obrigatório.
- `review_pull_request` com `event: 'APPROVE'` falha com `422` quando o autor do PR é o mesmo
  usuário do PAT — o GitHub não deixa ninguém aprovar o próprio PR. Como o PAT normalmente é da
  mesma conta que abriu o PR, na prática só `COMMENT` funciona em PRs próprios.
- `comment_pull_request` e `comment_issue` usam o endpoint de comentários de issue (a API do
  GitHub trata PR e issue como o mesmo recurso de comentário).
- `list_workflow_runs` sem `workflow` lista execuções de todos os workflows do repo; passando
  o nome do arquivo (ex: `deploy.yml`) filtra só aquele. Repositórios sem Actions configurado
  respondem lista vazia, não erro.
- `get_pages_site` e `get_pages_build_status` respondem `404` em repositórios sem GitHub Pages
  habilitado — não é erro de permissão, é o repo não ter Pages configurado.
- `get_pages_build_status` reflete o build clássico do Pages (source = branch/pasta). Sites que
  publicam via workflow do Actions (source = GitHub Actions) não têm "builds" nesse sentido —
  use `list_workflow_runs` para acompanhar o deploy desses.
- Branches protegidas continuam protegidas: o `merge_pull_request` respeita as regras do
  repositório (checks obrigatórios, revisão exigida) e falha com `405` se elas não forem
  atendidas. O Worker não tem como contornar isso, nem deveria.
- `get_pull_request_diff` trunca o diff (padrão 60.000 caracteres). PRs grandes vêm cortados —
  aumentar `max_chars` ajuda até o limite do que cabe no contexto.
- `create_branch` aceita branch ou SHA em `from`; tags não são resolvidas.
- `push_files` e `write_file` mandam o conteúdo como UTF-8/base64 de texto: não servem para
  arquivos binários.
- Access tokens não podem ser revogados individualmente antes de expirar (30 dias) — só trocando
  o `MCP_SECRET`, o que invalida todos de uma vez.
- `/authorize` não tem proteção contra tentativas repetidas de adivinhar o `MCP_SECRET` (sem
  rate limit nem bloqueio por tentativas). Para um segredo longo e aleatório o risco é baixo, mas
  é uma limitação a ter em mente.
- O `PAT` dá acesso a todos os repositórios que ele enxerga — se estiver com `All repositories`,
  qualquer ferramenta de escrita alcança qualquer repo da conta. Vale conferir `owner`/`repo`/
  `path` antes de aprovar cada chamada no conector.
