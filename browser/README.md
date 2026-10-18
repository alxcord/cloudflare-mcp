# browser (mcp-browser)

Proxy MCP seguro na frente de um Playwright MCP protegido pelo Cloudflare Access. O claude.ai e o
app do celular não enviam headers customizados em conectores, então este Worker autentica o
chamador por OAuth, injeta o Service Token do Access e repassa a requisição ao origin.

```
claude.ai ──OAuth Bearer──▶ mcp-browser.<seu-dominio>/mcp
                               │  injeta CF-Access-Client-Id / CF-Access-Client-Secret
                               ▼
                       browser.<seu-dominio>/mcp (Access, Service Auth)
                               ▼
                          Playwright MCP
```

## OAuth

O claude.ai usa registro dinâmico de cliente (RFC 7591), então o Worker expõe `POST /register`. O
`client_id` devolvido é um JWT assinado que carrega os `redirect_uris` aprovados, sem banco nem KV.
O fluxo segue OAuth 2.1 com PKCE S256 e o parâmetro `resource` (RFC 8707): o access token só vale
para `/mcp`. O access token dura 1 dia. O `refresh_token` dura 30 dias, renova a cada uso e tem
teto de 90 dias desde a aprovação, quando o claude.ai pede a senha de novo. Por ser stateless, o
refresh token antigo continua válido até expirar. Para revogar tudo, troque o `JWT_SECRET`.

## Proteções

`redirect_uri` restrito aos callbacks do claude.ai, conferido no registro e no `/authorize`. Só o
caminho `/mcp` e os métodos GET, POST e DELETE passam. O Worker descarta todos os headers do
cliente e reconstrói a requisição com uma allowlist (`Content-Type`, `Accept`, `mcp-session-id`,
`mcp-protocol-version`, `Last-Event-ID`). O header `Origin`, quando presente, precisa ser do
claude.ai, e só essas origens recebem headers CORS. O corpo da requisição é limitado a 1 MiB e a
resposta passa como stream (SSE preservado). A tela de aprovação usa CSP com nonce, sem script.
O rate limit por IP cobre `/register`, `/authorize`, `/token` e tentativas de `/mcp` sem Bearer
válido.

## Diagnóstico

Falhas do origin viram `502` com o tipo no corpo (`upstream_redirect`, `upstream_access_denied`,
`upstream_5xx`, `upstream_html`, `upstream_unreachable`) e um `console.error` com status, método,
content-type, host do redirect e `cf-ray`. Nunca entram tokens, secrets, headers nem corpos. Leia
no dashboard (Workers, mcp-browser, Observability) ou com `npx wrangler tail mcp-browser`. Como ler:
`upstream_redirect` ou `upstream_access_denied` apontam para o Access (Service Token errado, sem
policy Service Auth ou Host recusado pelo Playwright MCP). `upstream_5xx` aponta para o túnel ou
para o container. `upstream_unreachable` é falha de rede ou timeout (120 s). Configuração faltando
devolve `500 server_misconfigured` com a lista do que falta, só para quem tem Bearer válido.

## Secrets

Todos são criados com `wrangler secret put` ou no dashboard (tipo Secret), nunca em código, vars
ou README.

| Secret | Uso |
|---|---|
| `MCP_SECRET` | Senha digitada na tela `/authorize` (mínimo 32 caracteres) |
| `JWT_SECRET` | Opcional. Chave HMAC dos tokens (mínimo 32 caracteres). Sem ele, o `MCP_SECRET` assina |
| `CF_ACCESS_CLIENT_ID` | Client ID do Service Token |
| `CF_ACCESS_CLIENT_SECRET` | Client Secret do Service Token |

Variável `ORIGIN_URL` no `wrangler.jsonc`: URL https do Playwright MCP atrás do Access.

## Deploy

```bash
cd browser
npm i -D wrangler typescript @cloudflare/workers-types
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npx wrangler secret put MCP_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

Ajuste `routes` e `ORIGIN_URL` no `wrangler.jsonc` para o seu domínio. Funciona no plano Workers
Free. O Workers Logs no Free guarda os eventos por poucos dias.

## Testes

`WORKER=https://mcp-browser.<seu-dominio> ORIGIN=https://browser.<seu-dominio> ./tests.sh`

Cobre: metadata, registro dinâmico, authorize com PKCE e `resource`, token, refresh, `initialize`
com `mcp-session-id`, SSE, headers `CF-Access-*` do cliente ignorados e origin direto recusado.

## Conector no claude.ai

Em Configurações, Conectores, Adicionar conector personalizado, informe
`https://mcp-browser.<seu-dominio>/mcp` e deixe o OAuth vazio. Na tela de aprovação, cole o
`MCP_SECRET`. Marque as ferramentas como "Requer aprovação". Se o conector já existia com erro,
remova e adicione de novo para forçar um novo registro.

## Limitações e riscos

O Playwright MCP não é uma fronteira de segurança. As flags `--allowed-origins` e
`--blocked-origins` não cobrem redirects, então isole o container em uma rede docker sem acesso aos
serviços internos (risco de SSRF). O conteúdo das páginas abertas é dado não confiável e pode conter
prompt injection. O code de autorização é um JWT de 60 s sem uso único, protegido pelo PKCE.
