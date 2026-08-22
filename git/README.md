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
e expõe 6 ferramentas que chamam a API REST do GitHub usando um Personal Access Token guardado
como secret do Worker:

| Ferramenta | O que faz |
|---|---|
| `whoami` | Retorna o usuário do GitHub autenticado pelo token configurado |
| `list_dir` | Lista arquivos e pastas de um diretório de um repositório |
| `read_file` | Lê o conteúdo de um arquivo |
| `write_file` | Cria ou atualiza um único arquivo (um commit) |
| `push_files` | Cria ou atualiza vários arquivos em um único commit (usa a Git Trees API) |
| `delete_file` | Apaga um arquivo |

Todas as ferramentas recebem `owner` e `repo` como parâmetros — não é um MCP amarrado a um
repositório específico, funciona com qualquer repositório que o token tenha permissão de acessar.

Diferente do `mcp-wger` (que expõe ferramentas genéricas de REST — `api_get`, `api_post`, etc.),
aqui cada operação tem sua própria ferramenta: a parte da API do GitHub usada é pequena, estável
e bem conhecida, e algumas operações não são uma chamada só (o `push_files` orquestra cinco
chamadas encadeadas da Git Trees API para caber tudo em um commit).

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

O secret `PAT` não mudou na migração para OAuth — continua sendo o mesmo fine-grained token, com
`Contents: Read and write`. Se ele vazar, a forma de invalidar é revogar o token em
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
5. Em **Permissions > Repository permissions**, defina `Contents: Read and write`.
   `Metadata: Read-only` é marcado automaticamente (obrigatório).
6. Clique em **Generate token** e copie o valor imediatamente — o GitHub só mostra uma vez.

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
6. Depois de vinculado, em **Permissões de ferramentas**, todas as 6 ferramentas vêm com
   **"Requer aprovação"** por padrão — nada executa sem confirmação manual antes de cada chamada.

### 8. Validar

Peça pro Claude chamar a ferramenta `whoami`. Deve retornar o `login`, `name` e `id` da conta do
GitHub dona do token — confirmando que a cadeia completa (Claude → OAuth → Worker → GitHub) está
funcionando.

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) neste repositório e dar push na `main`. O
Cloudflare Workers Builds detecta o commit, builda e faz o deploy automaticamente — sem precisar
colar código manualmente no editor do painel.

**Cuidado com a auto-referência**: como é o próprio `mcp-git` que costuma escrever neste repo,
qualquer mudança que quebre a autenticação deste Worker derruba, no mesmo deploy, a ferramenta
que estava fazendo a mudança. Foi o que aconteceu na migração para OAuth: o commit precisou sair
inteiro de uma vez (`push_files`), e o conector só voltou a funcionar depois de reconfigurado à
mão no claude.ai. Mudanças assim exigem revisão antes do push, porque não dá para testar o
endpoint novo sem já ter desligado o antigo.

## Limitações conhecidas

- `push_files` cria um novo commit a partir do `HEAD` da branch no momento da chamada; não
  faz merge de conflitos — se o arquivo mudou entre a leitura e a escrita, o commit pode
  sobrescrever mudanças concorrentes.
- Não há suporte a branches protegidas, PRs ou revisão — as ferramentas escrevem direto na
  branch indicada (`main` por padrão).
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
