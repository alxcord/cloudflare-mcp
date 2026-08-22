# mcp-wger

Servidor MCP que dá ao Claude leitura e **escrita real** na API do Wger (app de treino/fitness),
usando a instância pública `wger.de`. Roda como Cloudflare Worker, arquivo único, sem build.

- Worker: `mcp-wger`
- Domínio: `https://mcp-wger.alexcordeiro.dev`
- Rota MCP: `https://mcp-wger.alexcordeiro.dev/mcp` (autenticada por **OAuth 2.1 + PKCE**, não
  por segredo na URL — ver [Autenticação](#autenticação))
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)
- Instância Wger: `https://wger.de` (nuvem pública, API `https://wger.de/api/v2/`)

> Este Worker é a segunda versão do padrão usado no [`mcp-git`](../git). A primeira versão
> autenticava com um segredo embutido na URL (`/<MCP_SECRET>/mcp`), igual ao `mcp-git` ainda
> usa hoje. Aqui migramos para OAuth por causa de um ponto de segurança: URL com segredo pode
> vazar por lugares que não são "o meio do caminho da requisição" — histórico do navegador, logs
> de acesso, header `Referer`, prints de tela — mesmo estando tudo em HTTPS. Ver a seção
> [Por que OAuth em vez de segredo na URL](#por-que-oauth-em-vez-de-segredo-na-url) para mais
> detalhes.

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP — `initialize`, `tools/list`, `tools/call`)
e expõe ferramentas que chamam a API REST v2 do Wger usando um **Permanent Token** guardado como
secret do Worker.

Diferente do `mcp-git` (que tem uma ferramenta dedicada por operação — `read_file`, `write_file`
etc.), aqui as ferramentas são **genéricas**, porque a API do Wger tem dezenas de recursos
(peso corporal, rotinas de treino, exercícios, diário nutricional, sessões de treino...) e seus
formatos de campo têm mudado entre versões da API. Em vez de fixar no código suposições que podem
ficar desatualizadas, o Worker só sabe falar REST genérico e é o Claude quem decide o endpoint e
o corpo de cada chamada, consultando a documentação/schema da API do Wger quando precisar
(`https://wger.de/api/v2/` lista os recursos disponíveis; há um schema OpenAPI em
`https://wger.de/api/v2/schema`).

| Ferramenta | O que faz |
|---|---|
| `whoami` | Retorna o perfil do usuário autenticado pelo token configurado (`GET /api/v2/userprofile/`) |
| `api_get` | GET genérico num recurso (`path`, `query` opcional) — para listar ou consultar qualquer coisa |
| `api_post` | POST genérico num recurso (`path`, `body`) — para criar registros (peso, sessão de treino, entrada no diário nutricional, etc.) |
| `api_patch` | PATCH genérico num registro existente (`path`, `id`, `body`) |
| `api_delete` | DELETE genérico num registro existente (`path`, `id`) |

Exemplos de uso pelo Claude:

- Registrar peso: `api_post` com `path="weightentry"` e `body={"weight": 82.4, "date": "2026-08-22"}`
- Ver rotinas de treino: `api_get` com `path="routine"`
- Buscar exercício: `api_get` com `path="exercise/search"` e `query={"term": "supino", "language": "pt"}`
- Ver diário nutricional de um plano: `api_get` com `path="nutritiondiary"` e `query={"plan": "123"}`

## Autenticação

Duas camadas:

1. **Claude → Worker**: OAuth 2.1 com PKCE. O Claude segue o fluxo padrão de *authorization
   code*: abre `/authorize` no navegador, você aprova colando o `MCP_SECRET` uma única vez (na
   hora de vincular o conector), o Worker devolve um código de uso único, o Claude troca esse
   código por um **access token Bearer** em `/token`, e passa a usar
   `Authorization: Bearer <token>` em toda chamada a `/mcp` daí em diante. O token expira em 30
   dias; depois disso o Claude repete o fluxo automaticamente.
2. **Worker → Wger**: o Worker autentica na API do Wger com um **Permanent Token**, guardado
   como secret `WGER_TOKEN`, mandado no header `Authorization: Token <valor>`.

Os secrets (`MCP_SECRET` e `WGER_TOKEN`) ficam só no Cloudflare, criptografados. Nunca aparecem
no código deste repositório.

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
nunca aparece em uma URL.

### Sobre o Permanent Token do Wger

É diferente do PAT do GitHub: não expira e não precisa de renovação. É gerado direto nas
configurações da conta em `wger.de` (seção **API key** / **Settings**), copiando o valor exibido
ali. Se vazar, a única forma de invalidar é gerar um novo token nas configurações da conta
(o que invalida o anterior).

## Passo a passo de configuração do zero

### 1. Ter o Permanent Token do Wger em mãos

1. Login em [wger.de](https://wger.de).
2. Ir em **Settings > API key** (ou **Configurações > Chave de API**, dependendo do idioma).
3. Copiar o token exibido (ou gerar um novo, se ainda não existir).

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!** para começar com um Worker de arquivo único editável
   direto no painel.
3. Dê o nome ao Worker: `mcp-wger`.
4. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository** e clique em **GitHub** (o app
   **Cloudflare Workers and Pages** já deve estar autorizado no repositório `cloudflare-mcp`,
   configurado durante a criação do `mcp-git`; se não estiver, autorize como descrito no
   [README do `mcp-git`](../git/README.md#3-conectar-o-worker-a-este-repositório-deploy-automático)).
2. Em **Connect to a repository**:
   - Repository: `cloudflare-mcp`
   - Production branch: `main`
   - Em **Advanced settings > Path**, defina `/wger` (a subpasta deste Worker dentro do
     monorepo).
   - Deploy command: `npx wrangler deploy` (padrão).
3. Clique em **Connect**. Um push nessa subpasta já dispara build e deploy automáticos daqui pra
   frente.

### 4. Configurar os secrets do Worker

1. Em **Settings > Variables and Secrets > Add variable**, adicione:
   - `WGER_TOKEN` — o Permanent Token copiado no passo 1. Marcar como **Secret**.
   - `MCP_SECRET` — uma string aleatória nova (não reaproveitar a do `mcp-git`). Marcar como
     **Secret**. Diferente da v1, ela não vai mais na URL — serve como senha da tela de
     aprovação e como chave de assinatura dos tokens OAuth.
2. Salve. Não precisa redeploy manual — o Worker lê os secrets em runtime.

### 5. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Escolha a mesma zona usada no `mcp-git` e defina o subdomínio `mcp-wger`.
3. O Cloudflare emite certificado SSL automaticamente. Em poucos minutos o Worker responde em
   `https://mcp-wger.alexcordeiro.dev`.

### 6. Testar antes de conectar ao Claude

A metadata OAuth deve responder normalmente:

```
GET https://mcp-wger.alexcordeiro.dev/.well-known/oauth-authorization-server
→ 200, JSON com authorization_endpoint e token_endpoint
```

Sem Bearer token, `/mcp` deve responder `401`:

```
POST https://mcp-wger.alexcordeiro.dev/mcp
→ 401, {"error":"invalid_token", ...}
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: algo identificável só para você (ex: `MCP Wger`).
3. **URL do servidor MCP remoto**: `https://mcp-wger.alexcordeiro.dev/mcp` (sem segredo nenhum
   na URL desta vez).
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo qualquer (ex:
   `claude-wger`) — evita que o Claude tente se auto-registrar via um endpoint que este Worker
   não implementa. Deixe **Client Secret** vazio (é um fluxo PKCE, não precisa).
5. Clique em **Adicionar** e depois em **Vincular**. Isso abre `/authorize` — cole o
   `MCP_SECRET` configurado no passo 4 e clique em **Aprovar**. O Claude troca o código pelo
   access token automaticamente nos bastidores.
6. Depois de vinculado, em **Permissões de ferramentas**, todas as ferramentas vêm com
   **"Requer aprovação"** por padrão — nada executa sem confirmação manual antes de cada chamada.

### 8. Validar

Peça pro Claude chamar a ferramenta `whoami`. Deve retornar o perfil do usuário dono do token —
confirmando que a cadeia completa (Claude → OAuth → Worker → Wger) está funcionando.

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) neste repositório e dar push na `main`. O
Cloudflare Workers Builds detecta o commit, builda e faz o deploy automaticamente.

## Limitações conhecidas

- Ferramentas genéricas (`api_get`/`api_post`/`api_patch`/`api_delete`) significam que o Claude
  precisa saber (ou consultar) o nome certo do recurso e os campos esperados — não há validação
  de schema no Worker, os erros que a API do Wger devolver (ex: campo obrigatório faltando) são
  repassados como texto.
- A API pública do Wger tem rate limit em alguns endpoints (ex: 120 req/min em listagens, 300
  req/min em detalhes); excesso retorna `429` com header `Retry-After`, que aparece como erro na
  resposta da ferramenta.
- Access tokens não podem ser revogados individualmente antes de expirar (30 dias) — só trocando
  o `MCP_SECRET`, o que invalida todos de uma vez.
- `/authorize` não tem proteção contra tentativas repetidas de adivinhar o `MCP_SECRET` (sem
  rate limit nem bloqueio por tentativas). Para um segredo longo e aleatório o risco é baixo, mas
  é uma limitação a ter em mente.
- O `WGER_TOKEN` não expira nem tem rotação automática. Se vazar, é preciso gerar um novo token
  nas configurações da conta do Wger.
