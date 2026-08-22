# mcp-memoria

Servidor MCP que dá ao Claude leitura e escrita real num **grafo de memória pessoal** persistido
em Cloudflare D1 (SQLite gerenciado). Inclui também uma **API REST** para acesso por scripts,
automações e qualquer ferramenta que fale HTTP.

- Worker: `mcp-memoria`
- Domínio: `https://mcp-memoria.<seu-dominio>`
- Rota MCP: `https://mcp-memoria.<seu-dominio>/mcp` (autenticada por **OAuth 2.1 + PKCE**)
- API REST: `https://mcp-memoria.<seu-dominio>/api/*` (autenticada por **Bearer token estático**)
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)
- Storage: Cloudflare D1 (binding `DB`, banco `memoria-db`)

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP) e expõe ferramentas para gravar e consultar
entidades (nós) e relações (arestas) num grafo persistido em D1. O mesmo grafo é acessível pela
API REST com autenticação separada por Bearer token estático.

**Ferramentas MCP:**

| Ferramenta | O que faz |
|---|---|
| `gravar_entidade` | Cria ou atualiza um nó (nome, tipo, atributos livres). Idempotente: se já existir, mescla os atributos. |
| `gravar_aresta` | Cria uma relação entre dois nós existentes (origem, tipo_relacao, destino). Idempotente. |
| `consultar` | Busca nós por tipo/nome ou faz traversal de arestas (ex: "artistas de MPB", "livros do mesmo autor"). |
| `remover_entidade` | Remove um nó e todas as arestas ligadas a ele. |

**API REST:**

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/api/init` | Cria as tabelas no D1 (rodar uma vez após o deploy) |
| `GET` | `/api/nodes` | Lista/busca nós (`?tipo=&nome=&limite=`) |
| `POST` | `/api/nodes` | Cria ou atualiza nó (`{nome, tipo, atributos}`) |
| `PATCH` | `/api/nodes/:id` | Atualiza campos de um nó pelo ID |
| `DELETE` | `/api/nodes/:id` | Remove nó e arestas ligadas |
| `POST` | `/api/edges` | Cria aresta (`{origem, tipo_relacao, destino}`) |
| `DELETE` | `/api/edges/:id` | Remove aresta pelo ID |
| `GET` | `/api/query` | Traversal de grafo (`?origem=&via_relacao=&destino=&tipo=&limite=`) |

## Schema do grafo

```
nodes: id (UUID) | tipo | nome | atributos (JSON) | criado_em | atualizado_em
edges: id (UUID) | origem (node.id) | tipo_relacao | destino (node.id) | criado_em
```

Exemplo de uso pelo Claude:
- Gravar: `gravar_entidade` com `nome="Silva"`, `tipo="artista"`, `atributos={"pais":"BR"}`
- Relacionar: `gravar_aresta` com `origem="Silva"`, `tipo_relacao="GENERO"`, `destino="MPB"`
- Consultar: `consultar` com `via_relacao="GENERO"`, `destino="MPB"`, `tipo="artista"` → retorna todos os artistas de MPB

## Autenticação

Duas camadas independentes:

1. **Claude → Worker (MCP)**: OAuth 2.1 com PKCE — mesmo padrão do `mcp-wger`. O Claude segue
   o fluxo de *authorization code*, você aprova colando o `MCP_SECRET` uma única vez na tela
   de aprovação. Um access token JWT (válido por 30 dias) passa a ser usado em toda chamada a
   `/mcp`. Stateless — sem banco, sem KV. Para invalidar, basta trocar o `MCP_SECRET`.

2. **Scripts/automações → Worker (REST API)**: Bearer token estático. Qualquer chamada a
   `/api/*` precisa do header `Authorization: Bearer <API_TOKEN>`. O `API_TOKEN` é um secret
   do Worker — defina qualquer string aleatória longa.

Os secrets (`MCP_SECRET` e `API_TOKEN`) ficam só no Cloudflare, criptografados. Nunca aparecem
no código deste repositório.

## Passo a passo de configuração do zero

### 1. Criar o banco D1 e obter o database_id

Execute no terminal (requer Wrangler instalado e autenticado):

```bash
wrangler d1 create memoria-db
```

A saída vai conter algo como:

```
✅ Successfully created DB 'memoria-db'
[[d1_databases]]
binding = "DB"
database_name = "memoria-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copie o `database_id`.

### 2. Atualizar o wrangler.toml com o database_id real

Substitua `SUBSTITUIR_PELO_ID_RETORNADO_NO_PASSO_1` em [`wrangler.toml`](./wrangler.toml) pelo
ID obtido acima e faça push (usando o `mcp-git` ou direto no repositório).

### 3. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!**.
3. Dê o nome: `mcp-memoria`.
4. Clique em **Deploy**.

### 4. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository**.
2. Selecione o repositório `cloudflare-mcp`.
3. Em **Advanced settings > Path**, defina `/memoria`.
4. Clique em **Connect**. O próximo push na subpasta dispara build e deploy automaticamente.

### 5. Configurar os secrets do Worker

Em **Settings > Variables and Secrets > Add variable**, adicione:

- `MCP_SECRET` — string aleatória longa (senha da tela de aprovação OAuth e chave de assinatura
  dos tokens). Marcar como **Secret**.
- `API_TOKEN` — string aleatória longa, diferente do `MCP_SECRET` (Bearer token da API REST).
  Marcar como **Secret**.

Não precisa de redeploy — os secrets são lidos em runtime.

### 6. Apontar um domínio próprio

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Defina o subdomínio `mcp-memoria` na mesma zona dos outros Workers.
3. O Cloudflare emite o certificado SSL automaticamente.

### 7. Inicializar as tabelas do banco (rodar uma única vez)

Após o primeiro deploy bem-sucedido:

```bash
curl -X POST https://mcp-memoria.<seu-dominio>/api/init \
  -H "Authorization: Bearer <API_TOKEN>"
# → {"ok":true,"message":"Tabelas criadas (ou já existiam)"}
```

Esse endpoint é idempotente — pode ser chamado de novo sem problema.

### 8. Testar antes de conectar ao Claude

```bash
# Metadata OAuth deve retornar 200
curl https://mcp-memoria.<seu-dominio>/.well-known/oauth-authorization-server

# /mcp sem token deve retornar 401
curl -X POST https://mcp-memoria.<seu-dominio>/mcp

# API REST deve listar nodes (vazio por enquanto)
curl https://mcp-memoria.<seu-dominio>/api/nodes \
  -H "Authorization: Bearer <API_TOKEN>"
# → {"nodes":[],"total":0}
```

### 9. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: `MCP Memória` (ou qualquer nome identificável).
3. **URL do servidor MCP remoto**: `https://mcp-memoria.<seu-dominio>/mcp`.
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo qualquer
   (ex: `claude-memoria`) — evita que o Claude tente registro automático.
   Deixe **Client Secret** vazio.
5. Clique em **Adicionar** e depois **Vincular**. Isso abre `/authorize` — cole o `MCP_SECRET`
   e clique em **Aprovar**.
6. Em **Permissões de ferramentas**, confirme que todas as ferramentas ficam com
   **"Requer aprovação"**.

### 10. Validar

Peça ao Claude:
```
Grave a entidade: nome="Silva", tipo="artista", atributos={"pais":"BR"}
```
Depois:
```
Consulte todas as entidades do tipo "artista"
```
Se retornar Silva, a cadeia completa (Claude → OAuth → Worker → D1) está funcionando.

## Usando a API REST

```bash
# Gravar nó
curl -X POST https://mcp-memoria.<seu-dominio>/api/nodes \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"nome":"Silva","tipo":"artista","atributos":{"pais":"BR"}}'

# Gravar aresta
curl -X POST https://mcp-memoria.<seu-dominio>/api/edges \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"origem":"Silva","tipo_relacao":"GENERO","destino":"MPB"}'

# Buscar artistas de MPB
curl "https://mcp-memoria.<seu-dominio>/api/query?via_relacao=GENERO&destino=MPB&tipo=artista" \
  -H "Authorization: Bearer <API_TOKEN>"
```

## Atualizando o código

Edite `worker.js` (e/ou `wrangler.toml`) e faça push na `main`. O Cloudflare Workers Builds
detecta o commit e faz o deploy automaticamente.

## Limitações conhecidas

- Busca por nome é `LIKE '%termo%'` (substring, case-insensitive). Não há busca fuzzy ou
  full-text — nomes precisam ser aproximadamente corretos para retornar resultados.
- Traversal de grafo suporta 1 salto direto. Para traversal multi-hop (ex: amigos de amigos),
  é preciso chamar `consultar` múltiplas vezes ou estender o Worker com uma CTE recursiva.
- A API REST não tem paginação por cursor — usa `limite` para controlar o tamanho do resultado.
- Access tokens MCP não podem ser revogados individualmente antes de expirar (30 dias). Para
  invalidar tudo de uma vez, troque o `MCP_SECRET`.
- O `API_TOKEN` é um segredo estático — não expira. Se vazar, troque o valor no Cloudflare.
