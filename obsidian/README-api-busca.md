# API REST do mcp-obsidian

Rotas em `https://mcp-obsidian.alexcordeiro.dev`. A autenticação usa `Authorization: Bearer <token>`. O token nunca vai na URL. Sem token ou com token inválido a resposta é 401. Token válido sem o escopo da rota recebe 403.

| Rota | Método | Escopo exigido | Para que serve |
|---|---|---|---|
| `/api/search` | GET | leitura ou admin | Busca que devolve só nomes de arquivos e as datas de atualização |
| `/api/init` | POST | admin | Cria as tabelas (idempotente) |
| `/api/manifest?vault=` | GET | admin | Caminho e hash das notas já indexadas |
| `/api/ingest` | POST | admin | Grava um lote de notas |
| `/api/delete` | POST | admin | Remove notas do índice |
| `/api/sync-status` | POST | admin | Registra a execução do sync (vault, commit_sha, commit_data) |
| `/openapi.json` | GET | pública | OpenAPI 3.1 de `/api/search`, sem segredos |
| `/mcp`, OAuth | | JWT (MCP_SECRET) | Fluxo do conector MCP, sem alteração |

O escopo admin usa o secret `API_TOKEN`. O escopo leitura usa o secret `SEARCH_TOKEN`, que só acessa `/api/search`. Se `SEARCH_TOKEN` não estiver definido ou estiver em branco, ele nunca casa com nenhuma chave: ninguém entra sem token e nada quebra.

## Busca

Parâmetros: `q` (obrigatório), `vault`, `pasta` (prefixo) e `limite` (padrão 10, máximo 30). Palavras casam por prefixo e todas precisam aparecer. Use aspas para frase exata.

```bash
curl -s -H "Authorization: Bearer $SEARCH_TOKEN" \
  "https://mcp-obsidian.alexcordeiro.dev/api/search?q=databricks%20unity&vault=trabalho&limite=5"
```

Resposta (a seção `atualizacao` vem a cada chamada, mesmo com zero resultados):

```json
{
  "atualizacao": [
    {
      "vault": "trabalho",
      "ultima_execucao_sync": "2026-11-07T23:17:02.000Z",
      "commit_indexado": { "sha": "969c67b", "data": "2026-11-07T13:00:00.000Z" },
      "ultima_nota_alterada": "2026-11-07T22:40:11.000Z"
    }
  ],
  "total": 1,
  "resultados": [
    { "posicao": 1, "vault": "trabalho", "path": "02-Areas/Dados/Databricks Unity Catalog.md", "title": "Databricks Unity Catalog" }
  ]
}
```

`ultima_execucao_sync` e `commit_indexado` ficam `null` até o primeiro sync com o registro ativo. Erros: 400 (q vazio ou vault inválido), 405 (método diferente de GET), 500 (mensagem genérica).

## Pastas bloqueadas

O secret `BLOCKED_FOLDERS` lista prefixos de pasta separados por vírgula. `/api/search` nunca devolve notas dessas pastas, nem com o parâmetro `pasta` explícito. A comparação ignora maiúsculas e minúsculas. Se o secret não existir ou estiver em branco, nenhuma pasta é bloqueada e nada dá erro. As ferramentas do `/mcp` (`buscar_notas`, `ler_nota`) não respeitam essa lista.

## Registro do sync

O indexador chama esta rota no fim de toda execução bem-sucedida, inclusive quando nenhuma nota mudou.

```bash
curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"vault":"trabalho","commit_sha":"969c67bdc20e7832aff649050760dca79029440b","commit_data":"2026-11-07T10:00:00-03:00"}' \
  https://mcp-obsidian.alexcordeiro.dev/api/sync-status
```

## Configuração

```bash
# Secrets (você roda; os valores não ficam em arquivo nem no repositório):
wrangler secret put SEARCH_TOKEN
wrangler secret put BLOCKED_FOLDERS    # opcional, ex.: 99-Privado,02-Areas/Financas
```

Não declare `BLOCKED_FOLDERS` em `[vars]` no `wrangler.toml`: variável e secret com o mesmo nome entram em conflito.
