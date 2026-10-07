# mcp-obsidian

Servidor MCP que dá ao Claude **busca rápida nas notas dos vaults Obsidian**, em vez de depender
da busca da API do GitHub. As notas são indexadas em Cloudflare D1 (SQLite gerenciado) com FTS5,
e um indexador mantém o índice em dia.

- Worker: `mcp-obsidian`
- Domínio: `https://mcp-obsidian.<seu-dominio>`
- Rota MCP: `https://mcp-obsidian.<seu-dominio>/mcp` (autenticada por **OAuth 2.1 + PKCE**)
- API do indexador: `https://mcp-obsidian.<seu-dominio>/api/*` (autenticada por **Bearer token estático**)
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)
- Indexador: [`indexador.py`](./indexador.py), vaults em [`vaults.json`](./vaults.json)
- Workflow: [`obsidian-indexar.yml`](../.github/workflows/obsidian-indexar.yml)
- Storage: Cloudflare D1 (binding `DB`, banco `obsidian-index`)

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP) e expõe ferramentas de busca sobre o índice.
Cada nota vira uma linha com caminho, título, pasta, tags e texto. O texto vem **sem imagens**
(base64, `![[...]]`, `![](...)` e `<img>` são removidos), e as tags ficam em campo próprio, o que
permite filtrar por tag de forma exata.

**Ferramentas MCP:**

| Ferramenta | O que faz |
|---|---|
| `buscar_notas` | Busca texto em título, tags e conteúdo. Palavras casam por prefixo e todas precisam aparecer; aspas dão frase exata. Filtra por `vault`, `pasta` e `tags`. Devolve caminho, título, tags e um trecho com o termo entre « ». |
| `buscar_por_tag` | Lista notas que tenham todas as tags informadas, sem busca de texto. |
| `listar_tags` | Lista as tags com a quantidade de notas, da mais usada para a menos usada. |
| `ler_nota` | Devolve o texto indexado de uma nota, por caminho ou por título. Notas longas vêm em partes (`deslocamento`). |
| `listar_vaults` | Lista os vaults indexados, com quantidade de notas e data da última indexação. |

**API do indexador:**

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/api/init` | Cria as tabelas no D1 (rodar uma vez após o deploy) |
| `GET` | `/api/manifest` | Caminho → hash das notas já indexadas (`?vault=`) |
| `POST` | `/api/ingest` | Grava um lote de notas (`{vault, notes: [...]}`) |
| `POST` | `/api/delete` | Remove notas (`{vault, paths: [...]}`) |

## Schema

```
notes:      vault | path | title | folder | tags | size | sha | indexed_at     (PK: vault, path)
note_tags:  vault | tag | path                                                  (PK: vault, tag, path)
notes_fts:  title | tags | body     (FTS5, rowid = rowid de notes, sem acento nem diferença de maiúsculas)
```

Toda tabela tem a coluna `vault`, então vários vaults convivem no mesmo banco. Tags são
normalizadas (minúsculas, sem acento, sem `#`), e `a/b/c` também gera `a` e `a/b`.

## Indexador

O [`indexador.py`](./indexador.py) lê os `.md` de um vault, limpa o texto, extrai as tags (do
frontmatter e do corpo, fora de blocos de código), pede o manifesto ao Worker e envia só o que
mudou. Notas apagadas saem do índice. Usa só a biblioteca padrão do Python.

```bash
# Só estatísticas, sem enviar nada
python3 obsidian/indexador.py --vault trabalho --root ../meu-vault --dry-run
```

Para indexar de verdade ele lê `INDEX_ENDPOINT` e `INDEX_API_TOKEN` (ou `--endpoint` e `--token`).
Cada execução escreve no máximo 50 mil linhas no D1 (`--max-escritas`). O limite gratuito é de
100 mil por dia e vale para a conta toda, então o que sobrar fica para a execução seguinte.

### Rodando pelo GitHub Actions

O workflow [`obsidian-indexar.yml`](../.github/workflows/obsidian-indexar.yml) roda de hora em
hora e sob demanda (**Actions > Indexar vaults Obsidian > Run workflow**). Ele baixa só os `.md`
de cada vault listado em [`vaults.json`](./vaults.json) e chama o indexador.

Para indexar outro vault, acrescente uma linha em `vaults.json`:

```json
[
  { "id": "trabalho", "repo": "alxcord/obsidian-trabalho" },
  { "id": "pessoal", "repo": "alxcord/obsidian-pessoal" }
]
```

## Autenticação

Duas camadas independentes, no mesmo padrão do `mcp-memoria`:

1. **Claude → Worker (MCP)**: OAuth 2.1 com PKCE. Você aprova colando o `MCP_SECRET` uma única vez
   na tela de aprovação. Um access token JWT (válido por 30 dias) passa a ser usado em toda
   chamada a `/mcp`. Stateless. Para invalidar, basta trocar o `MCP_SECRET`.
2. **Indexador → Worker (API)**: Bearer token estático. Toda chamada a `/api/*` precisa do header
   `Authorization: Bearer <API_TOKEN>`.

Os secrets ficam só no Cloudflare e no GitHub, criptografados. Nunca no código.

## Nota sobre o wrangler.toml

O campo `database_id` em [`wrangler.toml`](./wrangler.toml) tem o ID real do banco D1. Ele não é
uma credencial de acesso, e o Workers Builds precisa dele no arquivo para fazer o deploy.
Para usar outra conta, crie o banco (passo 1 abaixo) e troque o valor.

## Passo a passo de configuração do zero

### 1. Criar o banco D1 e atualizar o wrangler.toml

```bash
wrangler d1 create obsidian-index
```

Copie o `database_id` retornado e troque o valor em
[`wrangler.toml`](./wrangler.toml).

### 2. Criar o Worker no Cloudflare e conectar a este repositório

1. Em **Workers & Pages > Create application**, escolha **Start with Hello World!**, dê o nome
   `mcp-obsidian` e clique em **Deploy**.
2. No Worker, vá em **Settings > Build > Git repository**, selecione `cloudflare-mcp` e defina o
   **Path** como `/obsidian`. O domínio `mcp-obsidian.<seu-dominio>` já está declarado no
   `wrangler.toml`.

### 3. Configurar os secrets do Worker

Em **Settings > Variables and Secrets**, adicione como **Secret**:

- `MCP_SECRET`: string aleatória longa (senha da tela de aprovação e chave de assinatura dos tokens).
- `API_TOKEN`: string aleatória longa, diferente do `MCP_SECRET` (token do indexador).

### 4. Inicializar as tabelas (uma única vez)

```bash
curl -X POST https://mcp-obsidian.<seu-dominio>/api/init \
  -H "Authorization: Bearer <API_TOKEN>"
# → {"ok":true,"message":"Tabelas criadas (ou já existiam)"}
```

### 5. Configurar os secrets do GitHub Actions

Em **Settings > Secrets and variables > Actions** deste repositório:

- `OBSIDIAN_API_TOKEN`: o mesmo valor do `API_TOKEN` do Worker.
- `VAULTS_READ_TOKEN`: PAT fine-grained com **Contents: Read-only** nos repositórios dos vaults.

Se o domínio do Worker não for `mcp-obsidian.alexcordeiro.dev`, ajuste `INDEX_ENDPOINT` no workflow.

### 6. Rodar a primeira indexação

Em **Actions > Indexar vaults Obsidian > Run workflow**. Depois disso o workflow roda sozinho de
hora em hora.

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: `MCP Obsidian`.
3. **URL do servidor MCP remoto**: `https://mcp-obsidian.<seu-dominio>/mcp`.
4. Em **Configurações avançadas > ID do Cliente OAuth**, preencha um valor fixo (ex:
   `claude-obsidian`). Deixe **Client Secret** vazio.
5. Clique em **Adicionar** e depois em **Vincular**. Cole o `MCP_SECRET` na tela de aprovação.
6. Confirme que todas as ferramentas ficam com **"Requer aprovação"**.

> **Atenção:** a URL do conector deve incluir o sufixo `/mcp`.

### 8. Validar

Peça ao Claude: `Liste os vaults indexados` e depois `Busque notas sobre unity catalog com a tag databricks`.

## Atualizando o código

Edite `worker.js` (e/ou `wrangler.toml`) e faça push na `main`. O Cloudflare Workers Builds
faz o deploy automaticamente. Mudanças nas regras de limpeza do `indexador.py` exigem alterar
`VERSAO_LIMPEZA` no próprio arquivo, o que reenvia todas as notas na execução seguinte.

## Limitações conhecidas

- O índice atualiza de hora em hora (cron do workflow). Para atualizar na hora, rode o workflow
  manualmente.
- A busca casa palavras por prefixo e exige todas. Não há busca por sinônimo ou por significado.
- Notas são truncadas em 400 mil caracteres depois da limpeza. Imagens não são indexadas.
- `ler_nota` devolve o texto limpo (sem imagens, com `[[links]]` reduzidos ao nome). Para o
  arquivo original, use o `mcp-git`.
- O limite gratuito de escrita do D1 (100 mil linhas/dia) é da conta toda. A carga inicial de um
  vault de cerca de 2 mil notas usa uma fração disso, e o indexador para sozinho em 50 mil.
- Access tokens MCP não podem ser revogados individualmente antes de expirar (30 dias). Para
  invalidar tudo de uma vez, troque o `MCP_SECRET`.
- O `API_TOKEN` é um segredo estático e não expira. Se vazar, troque o valor no Cloudflare e no GitHub.
