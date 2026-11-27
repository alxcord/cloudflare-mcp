# play (mcp-play)

MCP do Google Play Console para os apps de uma conta de desenvolvedor, inclusive os que forem
criados depois. Lê e responde avaliações, consulta as faixas, gerencia os Grupos do Google das
faixas de teste, mantém produtos (compra única e assinaturas) e envia a declaração de Segurança
dos dados. O deploy dos apps fica fora: ele é feito pelo GitHub Actions de cada app.

```
claude.ai ──OAuth Bearer──▶ mcp-play.<seu-dominio>/mcp
                               │  conta de serviço: JWT RS256 (WebCrypto) → access token (cache)
                               ▼
           androidpublisher v3 + Play Developer Reporting API (apps:search)
```

## Ferramentas

Todas, exceto `listar_apps`, recebem `package_name`. O app só é aceito se o formato for válido e
se ele aparecer na listagem da conta de serviço (cache de 10 minutos, recarregado uma vez quando o
app não é encontrado).

| Ferramenta | O que faz | Escreve |
|---|---|---|
| `listar_apps` | Nome e package name dos apps acessíveis | Não |
| `listar_avaliacoes` | Avaliações recentes: nota, texto, idioma, versão, aparelho, data, resposta | Não |
| `ler_avaliacao` | Uma avaliação pelo `review_id` | Não |
| `responder_avaliacao` | Responde ou substitui a resposta | Sim |
| `listar_faixas` | Faixas com versões, version codes e status | Não |
| `ver_testadores` | Grupos do Google de uma faixa de teste | Não |
| `alterar_testadores` | Associa ou desassocia grupos de uma faixa de teste | Sim |
| `listar_produtos` | Produtos de compra única ou assinaturas | Não |
| `ler_produto` | JSON completo de um produto | Não |
| `salvar_produto` | Cria ou atualiza um produto (API monetization) | Sim |
| `mudar_estado_produto` | Ativa ou desativa opção de compra ou plano base | Sim |
| `atualizar_seguranca_dados` | Envia o CSV de Segurança dos dados | Sim |

As ferramentas que escrevem só aplicam com `confirmar=true`. Sem isso, devolvem um resumo do que vai
mudar (antes e depois, quando a API permite ler o estado atual) e não alteram nada.

## Limites da API do Google

| Recurso | Limite | Tratamento |
|---|---|---|
| Avaliações | Só com texto, só da produção, só criadas ou alteradas nos últimos 7 dias. Feedback de testadores não vem | Explicado na descrição da ferramenta e no retorno |
| Resposta | Até 350 caracteres, texto puro | Validado antes da chamada. HTML é recusado |
| Cota de avaliações | 200 leituras por hora e 2.000 respostas por dia, por app | Cada chamada busca uma página (até 100). 429 vira mensagem clara |
| Notificação | O usuário só é avisado na primeira resposta | Informado no resumo |
| Testadores | Só Grupos do Google. Listas de e-mail do Console não aparecem na API | A ferramenta trabalha com grupos. Membros são geridos em groups.google.com |
| Grupos comuns | Não há API para membros de grupo fora do Workspace/Cloud Identity | Fora do escopo |
| Segurança dos dados | Só escrita, sem leitura | O resumo não compara com a versão publicada |
| Outras declarações | Sem API (anúncios, público-alvo, permissões) | Só pelo Console |

## Edits e o deploy do GitHub Actions

Testadores e faixas usam um edit da API. A leitura abre o edit e descarta sem commit. A alteração de
testadores faz o commit só no final e descarta o edit em qualquer erro. O commit usa
`changesInReviewBehavior=ERROR_IF_IN_REVIEW`: se houver mudanças em revisão, ele falha em vez de
cancelar a revisão. Um commit invalida os outros edits abertos do app, então não altere testadores
enquanto um deploy do Actions estiver rodando.

## Permissões no Play Console

Use uma conta de serviço exclusiva do MCP, separada da que o Actions usa para o deploy. Convide em
Usuários e permissões, na aba Permissões da conta, para valer em todos os apps, inclusive os futuros.

| Permissão | Ferramentas |
|---|---|
| Ver informações do app e baixar relatórios em massa (somente leitura) | `listar_apps`, `listar_faixas`, leituras |
| Responder a avaliações | `responder_avaliacao` |
| Gerenciar faixas de teste e editar listas de testadores | `ver_testadores`, `alterar_testadores` |
| Gerenciar presença na loja | Produtos. Também permite editar ficha, preços e distribuição |
| Gerenciar declarações de política | `atualizar_seguranca_dados` |

Não conceda permissões de lançar versões, de produção nem financeiras. "Gerenciar presença na loja"
dá à chave poder sobre a ficha, os preços e a distribuição de todos os apps, mesmo sem ferramenta
para isso no MCP. Se a chave vazar, revogue-a no Google Cloud e gere outra.

## Instalação

1. No Google Cloud, no projeto usado pelo Play Console, ative a **Google Play Android Developer API**
   e a **Google Play Developer Reporting API**.
2. Em IAM e administrador, Contas de serviço, crie a conta `mcp-play` sem papéis do IAM e gere uma
   chave JSON.
3. No Play Console, convide o e-mail da conta com as permissões da tabela acima.
4. Crie o Worker `mcp-play` no Cloudflare e conecte este repositório em Workers Builds, com Root
   directory `play`.
5. Cadastre os secrets (tabela abaixo). Apague o JSON local depois.
6. Ajuste `routes` no `wrangler.jsonc` para o seu domínio e faça o push.

```bash
cd play
jq -r .client_email ~/caminho/chave.json | npx wrangler secret put GOOGLE_SA_EMAIL
jq -r .private_key  ~/caminho/chave.json | npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
npx wrangler secret put MCP_SECRET
npx wrangler secret put JWT_SECRET
```

## Secrets

Todos são do tipo Secret, nunca em código, vars ou README.

| Secret | Uso |
|---|---|
| `MCP_SECRET` | Senha digitada na tela `/authorize` (mínimo 32 caracteres) |
| `JWT_SECRET` | Opcional. Chave HMAC dos tokens OAuth (mínimo 32 caracteres). Sem ele, o `MCP_SECRET` assina |
| `GOOGLE_SA_EMAIL` | `client_email` do JSON da conta de serviço |
| `GOOGLE_SA_PRIVATE_KEY` | `private_key` do JSON (PEM PKCS#8). Aceita `\n` literal ou quebras de linha reais |

## OAuth e proteções

O mesmo do `browser/`: registro dinâmico de cliente, OAuth 2.1 com PKCE S256 e `resource`
(RFC 8707), tokens JWT HS256 sem banco. Access token de 1 dia, refresh de 30 dias com teto de 90.
`redirect_uri` restrito aos callbacks do claude.ai, `Origin` em allowlist, corpo limitado a 1 MiB,
rate limit por IP nos endpoints OAuth e em `/mcp` sem Bearer. O `/mcp` aceita só POST.

Toda entrada passa por validação: package name no formato Android (sem barra nem caracteres de URL),
e-mails de grupo, IDs de avaliação e de produto, faixas (produção é recusada), texto da resposta,
máscara de campos e CSV. Cada segmento de URL é codificado. O corpo de produto recebe `packageName`
e `productId` dos parâmetros validados, nunca do JSON enviado.

Erros: 403 vira "a conta de serviço não tem permissão nesse app", 429 explica as cotas, e nenhuma
mensagem traz token ou chave. O único log é `console.error` de configuração, sem dados de usuário.

## Testes

```bash
cd play
npm test           # Node 22.18+ roda TypeScript direto, sem dependências
```

Cobrem a assinatura do JWT (verificada com a chave pública), o cache do token, as validações, a
montagem de cada chamada e as ferramentas com a API mockada: confirmação, commit e descarte do
edit, 403 e 429, e o fluxo OAuth até o `tools/list`. O workflow `play-testes.yml` roda os testes a
cada mudança na pasta.

## Conector no claude.ai

1. Abra claude.ai em Configurações, Conectores, Adicionar conector personalizado.
2. Nome `Play Console`, URL `https://mcp-play.<seu-dominio>/mcp`. Deixe os campos de OAuth vazios.
3. Clique em Conectar. Na tela de aprovação, cole o `MCP_SECRET`. Faça esse passo num navegador sem o
   app do Claude instalado, porque o app intercepta o redirect do OAuth.
4. Marque todas as ferramentas como "Requer aprovação".
5. Abra uma conversa nova e chame `listar_apps` para validar a cadeia Claude → Worker → Google.

O conector vale também no app do celular, com a mesma conta.
