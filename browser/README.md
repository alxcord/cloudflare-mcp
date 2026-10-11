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

## Proteções

Autenticação OAuth 2.1 com PKCE e `redirect_uri` restrito aos callbacks do claude.ai. Só o caminho
`/mcp` e os métodos GET, POST e DELETE passam. O Worker descarta todos os headers do cliente e
reconstrói a requisição com uma allowlist (`Content-Type`, `Accept`, `mcp-session-id`,
`mcp-protocol-version`, `Last-Event-ID`). O header `Origin`, quando presente, precisa ser do
claude.ai. O corpo da requisição é limitado a 1 MiB, e o corpo da resposta passa como stream
(SSE preservado). Falhas do origin viram `502` genérico. O código nunca chama `console.log`.

## Secrets

Todos são criados com `wrangler secret put`, nunca em código, vars ou README.

| Secret | Uso |
|---|---|
| `MCP_SECRET` | Senha da tela `/authorize` e chave HMAC dos tokens (mínimo 32 caracteres) |
| `CF_ACCESS_CLIENT_ID` | Client ID do Service Token |
| `CF_ACCESS_CLIENT_SECRET` | Client Secret do Service Token |

## Deploy

```bash
cd browser
npm i -D wrangler typescript @cloudflare/workers-types
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npx wrangler secret put MCP_SECRET
npx wrangler deploy
```

Ajuste `routes` e `ORIGIN_URL` no `wrangler.jsonc` para o seu domínio. O bloco `limits.cpu_ms`
exige o plano Workers Paid. Crie também uma regra de rate limiting no WAF para o hostname do Worker.

## Testes

`WORKER=https://mcp-browser.<seu-dominio> ORIGIN=https://browser.<seu-dominio> ./tests.sh`

Cobre: chamada sem autenticação, caminho e método fora da allowlist, `initialize` com
`mcp-session-id`, SSE, headers `CF-Access-*` do cliente ignorados e origin direto recusado.
Confira os logs à parte com `npx wrangler tail mcp-browser`.

## Conector no claude.ai

Em Configurações, Conectores, Adicionar conector personalizado, informe
`https://mcp-browser.<seu-dominio>/mcp` e deixe o OAuth vazio. Na tela de aprovação, cole o
`MCP_SECRET`. Marque as ferramentas como "Requer aprovação".

## Limitações e riscos

O Playwright MCP não é uma fronteira de segurança. As flags `--allowed-origins` e
`--blocked-origins` não cobrem redirects, então isole o container em uma rede docker sem acesso aos
serviços internos (risco de SSRF). O conteúdo das páginas abertas é dado não confiável e pode conter
prompt injection.
