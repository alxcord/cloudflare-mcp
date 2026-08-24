# mcp-habitica

Servidor MCP que dá ao Claude leitura e **escrita real** na API do Habitica (app de hábitos
gamificado), usando a instância pública `habitica.com`. Roda como Cloudflare Worker, arquivo
único, sem build.

- Worker: `mcp-habitica`
- Domínio: `https://mcp-habitica.<seu-dominio>`
- Rota MCP: `https://mcp-habitica.<seu-dominio>/mcp` (autenticada por **OAuth 2.1 + PKCE**)
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)
- Instância Habitica: `https://habitica.com` (nuvem pública, API `https://habitica.com/api/v3/`)

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP — `initialize`, `tools/list`, `tools/call`)
e expõe ferramentas que chamam a API REST v3 do Habitica usando **User ID + API Token**
guardados como secrets do Worker.

A API do Habitica tem bastante superfície (User, Tasks, Tags, Group, Challenge, Content,
Member, Inbox...), então o Worker mistura dois estilos, como no `mcp-wger`: ferramentas
**dedicadas** para as ações do dia a dia (ver tarefas, pontuar hábito/tarefa — o núcleo do uso
prático do app) e ferramentas **genéricas** (`api_get`/`api_post`/`api_put`/`api_delete`) para
todo o resto, sem fixar no código suposições sobre campos que podem mudar.

| Ferramenta | O que faz |
|---|---|
| `whoami` | Retorna perfil e stats (HP, MP, XP, nível, gold) do usuário autenticado (`GET /api/v3/user`) |
| `listar_tarefas` | Lista tarefas do usuário, com filtro opcional de tipo (`habits`, `dailys`, `todos`, `rewards`, `completedTodos`) |
| `pontuar_tarefa` | Marca uma tarefa como feita/não feita (`POST /api/v3/tasks/:id/score/:direction`, direção `up` ou `down`) |
| `api_get` | GET genérico num recurso (`path`, `query` opcional) — tags, challenges, grupos, content, etc. |
| `api_post` | POST genérico num recurso (`path`, `body`) — criar tarefa, criar tag, entrar em desafio, etc. |
| `api_put` | PUT genérico num recurso existente (`path` completo incluindo id, `body`) — a API do Habitica usa **PUT**, não PATCH, para updates |
| `api_delete` | DELETE genérico num recurso existente (`path` completo incluindo id) |

Exemplos de uso pelo Claude:

- Ver hábitos e dailies pendentes: `listar_tarefas` com `type="dailys"`
- Completar uma to-do: `pontuar_tarefa` com `id="<uuid>"` e `direction="up"`
- Criar uma nova to-do: `api_post` com `path="tasks/user"` e
  `body={"type": "todo", "text": "Revisar PR"}`
- Editar o texto de uma tarefa: `api_put` com `path="tasks/<uuid>"` e `body={"text": "Novo título"}`
- Listar tags: `api_get` com `path="tags"`

O Worker sempre desembrulha a resposta padrão do Habitica (`{ success, data, ... }`) e devolve
só o campo `data`, já que o envelope externo não carrega informação útil pro Claude.

## Autenticação

Duas camadas:

1. **Claude → Worker**: OAuth 2.1 com PKCE. O Claude segue o fluxo padrão de *authorization
   code*: abre `/authorize` no navegador, você aprova colando o `MCP_SECRET` uma única vez (na
   hora de vincular o conector), o Worker devolve um código de uso único, o Claude troca esse
   código por um **access token Bearer** em `/token`, e passa a usar
   `Authorization: Bearer <token>` em toda chamada a `/mcp` daí em diante. O token expira em 30
   dias; depois disso o Claude repete o fluxo automaticamente.
2. **Worker → Habitica**: o Worker autentica na API do Habitica com **User ID + API Token**,
   guardados como secrets `HABITICA_USER_ID` e `HABITICA_API_TOKEN`, mandados nos headers
   `x-api-user` e `x-api-key`. Desde jul/2025 o Habitica também exige um header `x-client` em
   toda chamada autenticada, no formato `<user-id>-nome-da-ferramenta` — o Worker monta esse
   valor automaticamente (`<HABITICA_USER_ID>-mcp-habitica`); sem ele a API rejeita a
   requisição.

Os secrets (`MCP_SECRET`, `HABITICA_USER_ID`, `HABITICA_API_TOKEN`) ficam só no Cloudflare,
criptografados. Nunca aparecem no código deste repositório.

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

### Sobre o User ID e o API Token do Habitica

Diferente do PAT do GitHub, não há geração manual: os dois valores já existem desde a criação
da conta e ficam expostos direto numa tela de configurações — não é um fluxo de "criar
credencial", é "copiar valor existente":

- No site: `https://habitica.com/user/settings/api`
- No app: o menu mudou de nome ao longo do tempo — procure por **Settings > Authentication**
  (nem sempre aparece como "API").

Se o token vazar, é possível gerar um novo em **Report a Bug** ou contatando `admin@habitica.com`
(não há um botão de "regenerar" direto na tela de settings).

## Passo a passo de configuração do zero

### 1. Ter o User ID e o API Token do Habitica em mãos

1. Login em [habitica.com](https://habitica.com).
2. Ir em `https://habitica.com/user/settings/api` (ou, no app, **Settings > Authentication**).
3. Copiar os dois valores exibidos: **User ID** e **API Token**.

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!** para começar com um Worker de arquivo único editável
   direto no painel.
3. Dê o nome ao Worker: `mcp-habitica`.
4. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository** e clique em **GitHub** (o app
   **Cloudflare Workers and Pages** já deve estar autorizado no repositório `cloudflare-mcp`,
   configurado durante a criação do `mcp-git`; se não estiver, autorize como descrito no
   [README do `mcp-git`](../git/README.md#3-conectar-o-worker-a-este-repositório-deploy-automático)).
2. Em **Connect to a repository**:
   - Repository: `cloudflare-mcp`
   - Production branch: `main`
   - Em **Advanced settings > Path**, defina `/habitica` (a subpasta deste Worker dentro do
     monorepo).
   - Deploy command: `npx wrangler deploy` (padrão).
3. Clique em **Connect**. Um push nessa subpasta já dispara build e deploy automáticos daqui pra
   frente.

### 4. Configurar os secrets do Worker

1. Em **Settings > Variables and Secrets > Add variable**, adicione:
   - `HABITICA_USER_ID` — o User ID copiado no passo 1. Marcar como **Secret**.
   - `HABITICA_API_TOKEN` — o API Token copiado no passo 1. Marcar como **Secret**.
   - `MCP_SECRET` — uma string aleatória nova. Marcar como **Secret**.
2. Salve. Não precisa redeploy manual — o Worker lê os secrets em runtime.

### 5. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Escolha a mesma zona usada no `mcp-git` e defina o subdomínio `mcp-habitica`.
3. O Cloudflare emite certificado SSL automaticamente.

### 6. Testar antes de conectar ao Claude

A metadata OAuth deve responder normalmente:

```
GET https://mcp-habitica.<seu-dominio>/.well-known/oauth-authorization-server
→ 200, JSON com authorization_endpoint e token_endpoint
```

Sem Bearer token, `/mcp` deve responder `401`:

```
POST https://mcp-habitica.<seu-dominio>/mcp
→ 401, {"error":"invalid_token", ...}
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: algo identificável só para você (ex: `MCP Habitica`).
3. **URL do servidor MCP remoto**: `https://mcp-habitica.<seu-dominio>/mcp`.
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo qualquer (ex:
   `claude-habitica`). Deixe **Client Secret** vazio.
5. Clique em **Adicionar** e depois em **Vincular**. Cole o `MCP_SECRET` na tela de aprovação.
6. Confirme que todas as ferramentas ficam com **"Requer aprovação"**.

### 8. Validar

Peça pro Claude chamar a ferramenta `whoami`. Deve retornar o perfil do usuário dono do token —
confirmando que a cadeia completa (Claude → OAuth → Worker → Habitica) está funcionando.

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) neste repositório e dar push na `main`. O
Cloudflare Workers Builds detecta o commit, builda e faz o deploy automaticamente.

## Limitações conhecidas

- Ferramentas genéricas (`api_get`/`api_post`/`api_put`/`api_delete`) significam que o Claude
  precisa saber (ou consultar) o nome certo do recurso e os campos esperados — não há validação
  de schema no Worker, os erros que a API do Habitica devolver são repassados como texto.
- Rate limit documentado: **30 requisições por 60 segundos** por usuário. Excesso retorna `429`,
  que aparece como erro na resposta da ferramenta.
- Access tokens OAuth não podem ser revogados individualmente antes de expirar (30 dias) — só
  trocando o `MCP_SECRET`, o que invalida todos de uma vez.
- `/authorize` aplica um delay de 2s em tentativas de senha incorretas, dificultando força
  bruta, mas não impede flood de requisições (DoS por volume). Para proteção adicional, ative o
  **Bot Fight Mode** em **Security > Bots** no painel do Cloudflare.
- O `HABITICA_API_TOKEN` não expira nem tem rotação automática pela própria tela de
  configurações. Se vazar, é preciso pedir a regeneração via **Report a Bug** ou
  `admin@habitica.com`.
- `pontuar_tarefa` com `direction="down"` só faz sentido para habits com o lado negativo
  habilitado; usar em dailies/todos ou em habits sem esse lado retorna erro da própria API.
