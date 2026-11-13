# dieta (`mcp-dieta`)

Sistema pessoal de gestão da dieta em um Worker único no Cloudflare, com banco D1, API REST para a
interface web e servidor MCP para o Claude acessar os mesmos dados.

**Status:** especificação. Ainda não há `worker.js` nem `wrangler.toml` nesta pasta.

## Objetivo

Guardar com histórico:

- a dieta (refeições do plano e refeições alternativas);
- as metas de calorias, de proteínas e a distribuição de macronutrientes;
- as medições da balança (importadas de CSV).

E manter tabelas nutricionais públicas, só para consulta e cálculo.

## Decisões

| Tema | Decisão |
|---|---|
| Plataforma | Cloudflare Workers + D1, no mesmo padrão do repositório: um arquivo `worker.js`, sem build, sem npm |
| Interfaces | API REST (interface web) e MCP (JSON-RPC sobre HTTP, OAuth 2.1 com PKCE), sobre as mesmas funções |
| Histórico | Vigências: cada linha tem `vigente_de` e `vigente_ate`. Alterar fecha a linha atual e insere outra. Toda operação lê e escreve só sobre o que está vigente |
| Tabelas nutricionais | Sem histórico. Chave `(fonte, codigo)`. A carga de uma fonte substitui as linhas dessa fonte |
| Macros da refeição | Gravados na própria refeição. Os itens da refeição são opcionais e têm macros próprios |
| Tabela nutricional na refeição | Só ajuda a calcular. Os valores são copiados no momento do registro, então recarregar uma tabela não altera o que já foi gravado |
| Balança | A data da medição é a chave. A importação do CSV é idempotente |

## Arquitetura

```
Interface web ──► /api/*  (Bearer token)  ─┐
                                           ├─► Worker mcp-dieta ──► D1
Claude (custom connector) ──► /mcp (OAuth) ─┘          └──► API do Open Food Facts (cache por código de barras)
```

A interface web é uma página estática servida pelo próprio Worker. O detalhe dela fica para a fase 4.

## Modelo de dados

O SQL completo está em [`schema.sql`](./schema.sql).

| Tabela | Conteúdo | Histórico |
|---|---|---|
| `metas` | Calorias, proteína, distribuição de macros | Vigência |
| `plano_refeicao` | Refeições do plano, principais e alternativas, por horário (`slot`) | Vigência |
| `plano_item` | Itens opcionais de uma refeição, com macros e origem do cálculo | Preso à versão da refeição |
| `alimento` | Tabelas nutricionais (TACO, USDA, Open Food Facts e outras) | Não. Carga sobrescreve por fonte |
| `alimento_fts` | Índice FTS5 para busca por nome | Não |
| `medicao` | Medições da balança | A data é a chave |

### Vigências

- `vigente_de` e `vigente_ate` são texto ISO 8601 em UTC. `vigente_ate` nulo significa vigente.
- Um índice único parcial garante uma linha vigente por refeição (`refeicao_uid`) e uma em `metas`.
- Consulta "em uma data": `vigente_de <= :d AND (vigente_ate IS NULL OR vigente_ate > :d)`.
- Alterar uma refeição fecha a versão atual, insere a nova e copia os itens. Tudo em um `db.batch()` para ser atômico.
- Remover uma refeição só fecha a vigência. Nada é apagado.
- As views `metas_atual` e `plano_refeicao_atual` expõem só o que está vigente.

### Refeição, itens e macros

- A linha da refeição sempre guarda o total (`kcal`, `proteina_g`, `carboidrato_g`, `gordura_g`, `fibra_g`).
- Sem itens, o total é informado direto. Um hambúrguer pode ser uma única linha.
- Com itens, a API calcula o total como a soma dos itens e grava na refeição. Cada item exige calorias e os três macros. Fibra é opcional.
- O item pode guardar a origem do cálculo (`origem_fonte`, `origem_codigo`, `origem_gramas`), sem obrigação.
- A API devolve um aviso, sem bloquear, quando as calorias diferem mais de 15% de `4P + 4C + 9G`. Serve para pegar dado ruim vindo de rótulo.
- Refeição alternativa é uma linha com `tipo = 'alternativa'` no mesmo `slot` da principal.

## Fontes das tabelas nutricionais

| Fonte | Valor de `fonte` | Como entra |
|---|---|---|
| TACO 4ª ed. (NEPA/Unicamp) | `TACO` | Planilha fornecida pelo Alex |
| USDA Foundation Foods e SR Legacy | `USDA-FND`, `USDA-SR` | CSV baixado e carregado por script |
| IBGE POF 2008-2009 | `IBGE` | Opcional. Tabelas e medidas referidas |
| TBCA (USP) | `TBCA` | Só se houver exportação. Licença CC BY-NC-ND em um dos PDFs complementares |
| Open Food Facts | `OFF` | Consulta por código de barras e cache. Sem importação do dump |

Não entram o USDA Branded e o dump completo do Open Food Facts. Passam de 2 GB e estouram os 5 GB do D1.

Endereços de download, conferidos em 2026-11-12 nos resultados de busca. Os da NEPA, TBCA e IBGE não foram abertos:

- TACO: https://www.nepa.unicamp.br/taco/
- TBCA: https://www.tbca.net.br/
- IBGE POF, composição: https://www.ibge.gov.br/home/estatistica/populacao/condicaodevida/pof/2008_2009_composicao_nutricional/default.shtm
- IBGE POF, medidas referidas: https://www.ibge.gov.br/home/estatistica/populacao/condicaodevida/pof/2008_2009_medidas/default.shtm
- USDA: https://fdc.nal.usda.gov/download-datasets
- Open Food Facts, API: `https://world.openfoodfacts.org/api/v2/product/{codigo}.json`

## API REST

Prefixo `/api`, `Authorization: Bearer <API_TOKEN>`. O parâmetro `em` (data) consulta uma vigência passada.

| Método e rota | Função |
|---|---|
| `GET /api/metas` | Metas vigentes (ou `?em=`) |
| `PUT /api/metas` | Nova vigência de metas |
| `GET /api/metas/historico` | Todas as vigências |
| `GET /api/plano` | Refeições vigentes com itens (ou `?em=`) |
| `POST /api/plano/refeicoes` | Cria refeição |
| `PUT /api/plano/refeicoes/{uid}` | Nova versão da refeição |
| `DELETE /api/plano/refeicoes/{uid}` | Fecha a vigência |
| `GET /api/plano/refeicoes/{uid}/historico` | Versões da refeição |
| `GET /api/resumo` | Soma das refeições principais contra as metas |
| `GET /api/alimentos?q=&fonte=` | Busca por nome (FTS5) |
| `GET /api/alimentos/{fonte}/{codigo}` | Um alimento |
| `POST /api/alimentos/carga/{fonte}` | Substitui todas as linhas da fonte |
| `POST /api/alimentos/off/{codigo}` | Consulta o Open Food Facts e grava em cache |
| `GET /api/medicoes?de=&ate=` | Medições no período |
| `POST /api/medicoes/importar` | Importa o CSV da balança (upsert por data) |

## Ferramentas MCP

Endpoint `/mcp`. Cada ferramenta chama a mesma função da rota correspondente.

| Ferramenta | Rota equivalente |
|---|---|
| `consultar_metas` | `GET /api/metas` |
| `definir_metas` | `PUT /api/metas` |
| `consultar_plano` | `GET /api/plano` |
| `salvar_refeicao` | `POST` e `PUT` de refeições |
| `remover_refeicao` | `DELETE /api/plano/refeicoes/{uid}` |
| `consultar_historico` | rotas de histórico |
| `resumo_plano` | `GET /api/resumo` |
| `buscar_alimento` | `GET /api/alimentos` |
| `obter_alimento` | `GET /api/alimentos/{fonte}/{codigo}` |
| `importar_off` | `POST /api/alimentos/off/{codigo}` |
| `consultar_medicoes` | `GET /api/medicoes` |
| `importar_medicoes` | `POST /api/medicoes/importar` |

As ferramentas de escrita ficam como "Requer aprovação" no conector, como nos outros Workers.

## Segurança

- Secrets do Worker: `API_TOKEN` e as chaves do OAuth. Nunca no código.
- Os dados são de saúde. O banco D1 não tem acesso público, e os logs não registram valores de peso nem de refeições.
- A chamada ao Open Food Facts envia só o código de barras, com um `User-Agent` identificando o app.

## Limites do D1 (plano gratuito)

- 5 GB de armazenamento, 5 milhões de linhas lidas por dia e 100 mil escritas por dia.
- A leitura conta linhas varridas. Por isso a busca usa FTS5 e as consultas de vigência usam os índices parciais.
- Cada linha inserida em `alimento` também escreve no índice e no FTS. Cargas grandes (USDA SR Legacy, cerca de 7.800 alimentos) vão em lotes, se passarem da cota diária.
- Na recarga de uma fonte, `DELETE` seguido de `INSERT` mantém o FTS consistente. Para o cache do Open Food Facts, usar `ON CONFLICT DO UPDATE`, que preserva o `rowid`.

## Plano de implementação

1. `schema.sql`, carga da TACO e do USDA e busca por nome.
2. API de metas e do plano com vigências e `resumo`.
3. Servidor MCP com OAuth, sobre as funções da fase 2.
4. Interface web.
5. Importação do CSV da balança e consulta ao Open Food Facts.

## Pendências

- Formato do CSV da balança (colunas e separador). A tabela `medicao` tem colunas comuns e um campo `dados_json` para o que não mapear.
- Meta de proteína em gramas por dia ou em g/kg. Hoje o esquema guarda gramas, mais percentuais opcionais.
- Registro diário do que foi comido não está no escopo desta versão. Entra depois, se fizer falta.
- Se a TBCA tem exportação utilizável.
