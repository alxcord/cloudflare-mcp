# mcp-wger

Servidor MCP que dá ao Claude leitura e **escrita real** na API do Wger (app de treino/fitness),
usando a instância pública `wger.de`. Roda como Cloudflare Worker, arquivo único, sem build —
mesmo padrão do [`mcp-git`](../git).

- Worker: `mcp-wger`
- Domínio: `https://mcp-wger.alexcordeiro.dev`
- Rota MCP: `https://mcp-wger.alexcordeiro.dev/<MCP_SECRET>/mcp`
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)
- Instância Wger: `https://wger.de` (nuvem pública, API `https://wger.de/api/v2/`)

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

Duas camadas, igual ao `mcp-git`:

1. **Claude → Worker**: o segredo `MCP_SECRET` precisa estar no path da URL
   (`/<MCP_SECRET>/mcp`). Sem ele, ou com o valor errado, o Worker responde `401 Unauthorized`.
   Isso existe porque o custom connector do claude.ai não manda headers customizados.
2. **Worker → Wger**: o Worker autentica na API do Wger com um **Permanent Token**, guardado
   como secret `WGER_TOKEN`, mandado no header `Authorization: Token <valor>`.

Os dois secrets (`MCP_SECRET` e `WGER_TOKEN`) ficam só no Cloudflare, criptografados. Nunca
aparecem no código deste repositório.

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
   - `MCP_SECRET` — uma string aleatória nova (não reaproveitar a do `mcp-git`), usada como parte
     da URL. Marcar como **Secret**.
2. Salve. Não precisa redeploy manual — o Worker lê os secrets em runtime.

### 5. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Escolha a zona `alexcordeiro.dev` e defina o subdomínio `mcp-wger`.
3. O Cloudflare emite certificado SSL automaticamente. Em poucos minutos o Worker responde em
   `https://mcp-wger.alexcordeiro.dev`.

### 6. Testar antes de conectar ao Claude

Sem o secret certo, a rota deve responder `401 Unauthorized`:

```
GET https://mcp-wger.alexcordeiro.dev/secret-errado/mcp
→ Unauthorized
```

Com o secret certo mas sem ser um POST, deve responder `405 Method not allowed`:

```
GET https://mcp-wger.alexcordeiro.dev/<MCP_SECRET>/mcp
→ Method not allowed
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: algo identificável (ex: `MCP Wger (alexcordeiro.dev)`).
3. **URL do servidor MCP remoto**: `https://mcp-wger.alexcordeiro.dev/<MCP_SECRET>/mcp` — troque
   `<MCP_SECRET>` pelo valor real configurado no passo 4. **Confira visualmente antes de colar**
   que o campo não foi preenchido com outra coisa.
4. Deixe **OAuth Client ID/Secret** vazios (não usamos OAuth, a autenticação é via URL).
5. Clique em **Adicionar** e depois em **Vincular**.
6. Se aparecer erro ao vincular, o mais comum é o secret da URL não bater com o `MCP_SECRET`
   salvo no Cloudflare — confira os dois valores.
7. Depois de vinculado, em **Permissões de ferramentas**, todas as ferramentas vêm com
   **"Requer aprovação"** por padrão — nada executa sem confirmação manual antes de cada chamada.

### 8. Validar

Peça pro Claude chamar a ferramenta `whoami`. Deve retornar o perfil do usuário dono do token —
confirmando que a cadeia completa (Claude → Worker → Wger) está funcionando.

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
- O `MCP_SECRET` e o `WGER_TOKEN` não expiram nem têm rotação automática. Se vazarem, é preciso
  gerar um novo token no Wger e/ou trocar o `MCP_SECRET` no Cloudflare, atualizando a URL no
  custom connector do Claude.
