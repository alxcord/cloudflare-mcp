# mcp-pushover

Servidor MCP que dá ao Claude a capacidade de enviar **notificações push reais** para o
celular, via [Pushover](https://pushover.net). Roda como Cloudflare Worker, arquivo único,
sem build.

- Worker: `mcp-pushover`
- Domínio: `https://mcp-pushover.<seu-dominio>`
- Rota MCP: `https://mcp-pushover.<seu-dominio>/mcp` (autenticada por **OAuth 2.1 + PKCE**)
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)
- Serviço: `https://pushover.net` (nuvem pública, API `https://api.pushover.net/1/messages.json`)

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP — `initialize`, `tools/list`, `tools/call`)
e expõe uma ferramenta que chama a API de envio do Pushover usando um **Application Token** e
uma **User Key** guardados como secrets do Worker.

Diferente do `mcp-wger` (ferramentas genéricas, porque a API tem dezenas de recursos), a API do
Pushover é pequena e estável — um único endpoint de envio — então este Worker segue o padrão do
`mcp-git`: uma ferramenta dedicada.

| Ferramenta | O que faz |
|---|---|
| `send_notification` | Envia uma notificação push (`message` obrigatório; `title`, `priority`, `url`, `url_title` opcionais) |

Exemplo de uso pelo Claude: `send_notification` com `message="build falhou"` e `priority=1`.

## Autenticação

Duas camadas:

1. **Claude → Worker**: OAuth 2.1 com PKCE. O Claude segue o fluxo padrão de *authorization
   code*: abre `/authorize` no navegador, você aprova colando o `MCP_SECRET` uma única vez (na
   hora de vincular o conector), o Worker devolve um código de uso único, o Claude troca esse
   código por um **access token Bearer** em `/token`, e passa a usar
   `Authorization: Bearer <token>` em toda chamada a `/mcp` daí em diante. O token expira em 30
   dias; depois disso o Claude repete o fluxo automaticamente.
2. **Worker → Pushover**: o Worker autentica na API do Pushover enviando o **Application
   Token** (secret `PUSHOVER_TOKEN`) e a **User Key** (secret `PUSHOVER_USER`) no corpo de cada
   chamada.

Os secrets (`MCP_SECRET`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`) ficam só no Cloudflare,
criptografados. Nunca aparecem no código deste repositório.

### Como a autenticação OAuth funciona por dentro (sem banco de dados)

Idêntico ao padrão usado nos outros Workers deste repositório (ver
[`wger/README.md`](../wger/README.md#como-a-autenticação-oauth-funciona-por-dentro-sem-banco-de-dados)):
tudo é **stateless**, usando JWTs (HS256) assinados com o `MCP_SECRET` via `crypto.subtle`
nativo do Workers. Trocar o `MCP_SECRET` no Cloudflare invalida instantaneamente qualquer
código ou token já emitido.

### Sobre as credenciais do Pushover

- **User Key**: aparece direto na tela principal da sua conta em `pushover.net`, sem precisar
  gerar nada.
- **Application Token**: criado em **pushover.net > Apps & Plugins > Create an Application/API
  Token** (qualquer nome serve, ex: "Claude"). Nenhum dos dois expira; se vazar, a forma de
  invalidar é deletar a aplicação (revoga o token) ou trocar de conta (revoga a user key).

## Passo a passo de configuração do zero

### 1. Ter as credenciais do Pushover em mãos

1. Instalar o app Pushover no celular e criar conta.
2. Copiar a **User Key**, exibida na tela principal em [pushover.net](https://pushover.net).
3. Em **Apps & Plugins > Create an Application/API Token**, criar uma aplicação e copiar o
   **API Token/Key** gerado.

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!**.
3. Dê o nome ao Worker: `mcp-pushover`.
4. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository** e clique em **GitHub** (o app
   **Cloudflare Workers and Pages** já deve estar autorizado no repositório `cloudflare-mcp`).
2. Em **Connect to a repository**:
   - Repository: `cloudflare-mcp`
   - Production branch: `main`
   - Em **Advanced settings > Path**, defina `/pushover`.
   - Deploy command: `npx wrangler deploy` (padrão).
3. Clique em **Connect**. Um push nessa subpasta já dispara build e deploy automáticos.

### 4. Configurar os secrets do Worker

1. Em **Settings > Variables and Secrets > Add variable**, adicione:
   - `PUSHOVER_TOKEN` — o Application Token copiado no passo 1. Marcar como **Secret**.
   - `PUSHOVER_USER` — a User Key copiada no passo 1. Marcar como **Secret**.
   - `MCP_SECRET` — uma string aleatória nova. Marcar como **Secret**.
2. Salve. Não precisa redeploy manual.

### 5. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Escolha a mesma zona usada nos outros Workers e defina o subdomínio `mcp-pushover`.
3. O Cloudflare emite certificado SSL automaticamente.

### 6. Testar antes de conectar ao Claude

```
GET https://mcp-pushover.<seu-dominio>/.well-known/oauth-authorization-server
→ 200, JSON com authorization_endpoint e token_endpoint
```

```
POST https://mcp-pushover.<seu-dominio>/mcp
→ 401, {"error":"invalid_token", ...}
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: algo identificável só para você (ex: `MCP Pushover`).
3. **URL do servidor MCP remoto**: `https://mcp-pushover.<seu-dominio>/mcp`.
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo qualquer (ex:
   `claude-pushover`). Deixe **Client Secret** vazio.
5. Clique em **Adicionar** e depois em **Vincular**. Cole o `MCP_SECRET` na tela de aprovação.
6. Confirme que a ferramenta fica com **"Requer aprovação"**.

### 8. Validar

Peça pro Claude chamar `send_notification` com uma mensagem de teste. A notificação deve chegar
no celular — confirmando que a cadeia completa (Claude → OAuth → Worker → Pushover) está
funcionando.

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) neste repositório e dar push na `main`. O
Cloudflare Workers Builds detecta o commit, builda e faz o deploy automaticamente.

## Limitações conhecidas

- Access tokens não podem ser revogados individualmente antes de expirar (30 dias) — só
  trocando o `MCP_SECRET`, o que invalida todos de uma vez.
- `/authorize` aplica um delay de 2s em tentativas de senha incorretas; para proteção adicional
  contra flood de requisições, ative o **Bot Fight Mode** em **Security > Bots**.
- O plano gratuito do Pushover limita 10.000 mensagens/mês por Application Token — mais que
  suficiente para uso pessoal, mas vale saber que existe o limite.
- `priority=2` (emergência) exige parâmetros extras (`retry`, `expire`) para repetir o alerta
  até confirmação; esta ferramenta não implementa esse fluxo, então prioridade 2 é aceita pela
  API mas sem repetição automática.
