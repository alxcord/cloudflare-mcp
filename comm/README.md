# comm

Worker que funciona como um **hub de comunicação pessoal**: hoje recebe e responde comandos via
Telegram e recebe relatórios de status de um dispositivo de monitoramento de rede local (com um
"dead man's switch" para detectar silêncio prolongado). É pensado para crescer para outros
canais no futuro (ex.: um modo via MCP para o Claude, ou uma interface web), por isso o nome não
referencia "Telegram" nem "MCP" diretamente.

- Worker: `comm`
- Domínio: `https://comm.<seu-dominio>`
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)

**Diferente dos outros Workers deste repositório, este não implementa o protocolo MCP** (sem
`initialize`/`tools/list`/`tools/call`, sem OAuth). É um receptor de webhooks HTTP simples,
autenticado por secret direto. Mora no mesmo monorepo e segue o mesmo padrão de deploy dos
demais.

## O que ele faz

| Rota | Método | O que faz |
|---|---|---|
| `/telegram/webhook` | POST | Recebe updates do Telegram (mensagens/comandos), valida o remetente contra uma lista de usuários autorizados em KV, e responde |
| `/esp32/status` | POST | Recebe relatório periódico de status de um dispositivo de monitoramento de rede local (ex.: um microcontrolador que faz ping em equipamentos da rede) |
| _(scheduled)_ | cron | Roda a cada 10 minutos; se o dispositivo de monitoramento não reportar por mais de 30 minutos, dispara um alerta ("dead man's switch") |

### Comandos disponíveis no Telegram (hoje)

- `/start` — mensagem de boas-vindas
- `/ajuda` — lista os comandos
- `/deco status` — retorna o último status reportado pelo dispositivo de monitoramento e há
  quanto tempo isso aconteceu

O roteamento de comando hoje é fixo (comparação direta de texto), no mesmo espírito dos outros
Workers deste repo: ferramentas dedicadas primeiro, generalização depois. Um comando não
reconhecido cai num ponto de extensão (`handleFallback`) pensado para, no futuro, delegar a
interpretação de linguagem livre a um LLM.

### Por que existe um "dead man's switch"

Um dispositivo de monitoramento na rede local não consegue ser *consultado* de fora (uma rede
doméstica não é acessível pela internet pública). A solução é inverter o fluxo: o dispositivo
**empurra** um relatório de status periodicamente para este Worker. Isso cobre dois cenários de
falha:

1. O dispositivo está de pé e reporta que algo específico está offline → alerta imediato.
2. O dispositivo (ou a rede local inteira) para de reportar → o cron detecta o silêncio além do
   tempo limite e avisa que algo está errado, mesmo sem saber exatamente o quê.

## Autenticação

Três secrets, sem OAuth — mais simples que os outros Workers porque quem chama este Worker não
é o Claude via custom connector, e sim o Telegram e um dispositivo próprio:

- `TELEGRAM_BOT_TOKEN` — token do bot, usado para chamar `sendMessage` na API do Telegram.
- `TELEGRAM_WEBHOOK_SECRET` — string aleatória própria, registrada junto com `setWebhook` (campo
  `secret_token`). O Telegram devolve esse valor no cabeçalho
  `X-Telegram-Bot-Api-Secret-Token` em todo update; o Worker rejeita qualquer requisição em que
  esse valor não bata.
- `ESP32_TOKEN` — string aleatória própria, usada como Bearer token pelo dispositivo de
  monitoramento ao chamar `/esp32/status` (`Authorization: Bearer <token>`).

Os três ficam só no Cloudflare, marcados como **Secret** (nunca `Plaintext`), e nunca aparecem
no código deste repositório.

### Autorização de usuários (KV)

Diferente da autenticação acima (que garante que a *requisição* é legítima), a autorização
decide **quem pode usar o bot** depois que um update do Telegram já foi validado como legítimo.
Fica numa tabela simples no KV namespace `COMM_KV`:

```
chave: users:<chat_id>
valor: { "nome": "...", "papel": "admin", "ativo": true }
```

Chat IDs ausentes ou com `"ativo": false` são ignorados silenciosamente — o bot não revela nem
confirma que existe para remetentes não autorizados.

## Passo a passo de configuração do zero

### 1. Criar o bot no Telegram

1. No Telegram, abra uma conversa com **@BotFather**.
2. Envie `/newbot`, escolha um nome e um username terminado em `bot`.
3. Guarde o token retornado — vai virar o secret `TELEGRAM_BOT_TOKEN`.

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application > Start with Hello World!**.
2. Nomeie o Worker: `comm`.
3. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório

1. Em **Settings > Build > Git repository**, conecte ao repositório deste monorepo.
2. Production branch: `main`. Em **Advanced settings > Path**, defina `/comm`.
3. Deploy command: `npx wrangler deploy` (padrão).

### 4. Criar o KV namespace e configurar os secrets

1. Em **Workers & Pages > KV**, crie um namespace (ex.: `comm-kv`) e copie o ID.
2. No `wrangler.toml` deste Worker, substitua `SUBSTITUIR_PELO_ID_DO_KV_NAMESPACE` pelo ID
   real, ou vincule pelo painel em **Settings > Bindings > Add > KV Namespace** com o binding
   `COMM_KV`.
3. Em **Settings > Variables and Secrets**, adicione como **Secret**:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (gere uma string aleatória própria)
   - `ESP32_TOKEN` (gere outra string aleatória própria)

### 5. Cadastrar seu próprio usuário autorizado

Grave uma chave no KV pelo painel do Cloudflare (**Workers & Pages > KV > seu namespace >
Add entry**):

```
Key:   users:<seu-chat-id>
Value: {"nome":"<seu-nome>","papel":"admin","ativo":true}
```

Para descobrir seu próprio `chat_id`, mande qualquer mensagem para o bot recém-criado e acesse
`https://api.telegram.org/bot<TOKEN>/getUpdates` — o campo `chat.id` da resposta é o valor.

### 6. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**, use a mesma zona dos outros Workers e
   defina o subdomínio `comm`.

### 7. Registrar o webhook do Telegram

Chame uma vez (não precisa repetir depois, a menos que o token ou a URL mudem):

```
POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
Content-Type: application/json

{
  "url": "https://comm.<seu-dominio>/telegram/webhook",
  "secret_token": "<mesmo valor de TELEGRAM_WEBHOOK_SECRET>"
}
```

### 8. Testar antes de considerar pronto

Sem o cabeçalho de secret, o webhook deve responder `401`:

```
POST https://comm.<seu-dominio>/telegram/webhook
→ 401 Unauthorized
```

Mande `/start` para o bot pelo Telegram — se seu `chat_id` já estiver cadastrado no KV (passo
5), o bot deve responder a mensagem de boas-vindas.

### 9. Configurar o dispositivo de monitoramento

O dispositivo (ex.: um microcontrolador na rede local) deve enviar, periodicamente (sugestão: a
cada 10 minutos), uma requisição como:

```
POST https://comm.<seu-dominio>/esp32/status
Authorization: Bearer <ESP32_TOKEN>
Content-Type: application/json

{ "equipamentos": { "<nome-do-equipamento-1>": "online", "<nome-do-equipamento-2>": "offline" } }
```

### 10. Validar de ponta a ponta

No Telegram, envie `/deco status` para o bot. A resposta deve mostrar o último relatório
recebido do dispositivo de monitoramento e há quanto tempo isso ocorreu.

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) e dar push na `main`. O Cloudflare Workers
Builds detecta o commit na subpasta `/comm` e faz o deploy automaticamente.

## Limitações conhecidas

- Roteamento de comando é por comparação exata de texto — sem tolerância a variações de
  digitação. Fica para uma evolução futura (ver seção "Na estrada" do `README.md` da raiz).
- O "dead man's switch" só percebe silêncio dentro da granularidade do cron (a cada 10
  minutos) somada ao tempo limite configurado (30 minutos) — não é detecção em tempo real.
- Não há retry nem fila: se `sendMessage` falhar (ex.: rate limit do Telegram), a notificação
  daquele ciclo é perdida silenciosamente.
- A lista de usuários autorizados é gerenciada manualmente pelo painel do Cloudflare (KV); não
  há ainda uma ferramenta dedicada para adicionar/remover usuários.
- Pensado para uso pessoal/doméstico de baixo volume — sem tratamento de concorrência ou de
  picos de tráfego.
