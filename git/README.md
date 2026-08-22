# mcp-git

Servidor MCP que dá ao Claude leitura e **escrita real** em repositórios do GitHub, contornando
a limitação do conector oficial (que é só leitura). Roda como Cloudflare Worker, arquivo único,
sem build.

- Worker: `mcp-git`
- Domínio: `https://mcp-git.alexcordeiro.dev`
- Rota MCP: `https://mcp-git.alexcordeiro.dev/<MCP_SECRET>/mcp`
- Código: [`worker.js`](./worker.js)
- Config do Worker: [`wrangler.toml`](./wrangler.toml)

## O que ele faz

Implementa o protocolo MCP (JSON-RPC 2.0 sobre HTTP — `initialize`, `tools/list`, `tools/call`)
e expõe 6 ferramentas que chamam a API REST do GitHub usando um Personal Access Token guardado
como secret do Worker:

| Ferramenta | O que faz |
|---|---|
| `whoami` | Retorna o usuário do GitHub autenticado pelo token configurado |
| `list_dir` | Lista arquivos e pastas de um diretório de um repositório |
| `read_file` | Lê o conteúdo de um arquivo |
| `write_file` | Cria ou atualiza um único arquivo (um commit) |
| `push_files` | Cria ou atualiza vários arquivos em um único commit (usa a Git Trees API) |
| `delete_file` | Apaga um arquivo |

Todas as ferramentas recebem `owner` e `repo` como parâmetros — não é um MCP amarrado a um
repositório específico, funciona com qualquer repositório que o token tenha permissão de acessar.

## Autenticação

Duas camadas:

1. **Claude → Worker**: o segredo `MCP_SECRET` precisa estar no path da URL
   (`/<MCP_SECRET>/mcp`). Sem ele, ou com o valor errado, o Worker responde `401 Unauthorized`.
   Isso existe porque o custom connector do claude.ai não manda headers customizados.
2. **Worker → GitHub**: o Worker autentica na API do GitHub com um Personal Access Token
   fine-grained, guardado como secret `PAT`.

Os dois secrets (`MCP_SECRET` e `PAT`) ficam só no Cloudflare, criptografados. Nunca aparecem no
código deste repositório.

## Passo a passo de configuração do zero

### 1. Criar o Personal Access Token no GitHub

1. Acesse [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Dê um nome (ex: `MCP Worker - <finalidade>`).
3. Em **Expiration**, escolha o prazo (o Cloudflare permite `No expiration`, mas o GitHub avisa
   que não é o ideal em termos de segurança — considere um prazo definido e renovar depois).
4. Em **Repository access**, escolha:
   - `Only select repositories` e selecione só os repositórios que esse MCP vai precisar, **ou**
   - `All repositories`, se o MCP precisa escrever em vários repos (ex: site pessoal + vault do
     Obsidian).
5. Em **Permissions > Repository permissions**, defina `Contents: Read and write`.
   `Metadata: Read-only` é marcado automaticamente (obrigatório).
6. Clique em **Generate token** e copie o valor imediatamente — o GitHub só mostra uma vez.

### 2. Criar o Worker no Cloudflare

1. No [dashboard do Cloudflare](https://dash.cloudflare.com), vá em **Workers & Pages > Create
   application**.
2. Escolha **Start with Hello World!** para começar com um Worker de arquivo único editável
   direto no painel.
3. Dê o nome ao Worker (ex: `mcp-git`). **Atenção**: o nome não pode ser mudado depois pelo
   editor de código, só em **Settings > General > Name** (renomeia o Worker, mas não muda a URL
   `*.workers.dev` já gerada).
4. Clique em **Deploy**.

### 3. Conectar o Worker a este repositório (deploy automático)

1. No Worker, vá em **Settings > Build > Git repository** e clique em **GitHub**.
2. Autorize o app **Cloudflare Workers and Pages** no GitHub, escolhendo **Only select
   repositories** e marcando só este repositório (`cloudflare-mcp`) — evita dar acesso a todos
   os repos da conta para o app do Cloudflare.
3. De volta no Cloudflare, em **Connect to a repository**:
   - Repository: `cloudflare-mcp`
   - Production branch: `main`
   - Em **Advanced settings > Path**, defina `/git` (a subpasta deste Worker dentro do
     monorepo).
   - Deploy command: `npx wrangler deploy` (padrão).
4. Clique em **Connect**. Um push nessa subpasta já dispara build e deploy automáticos daqui
   pra frente.

### 4. Configurar os secrets do Worker

1. Em **Settings > Variables and Secrets > Add variable**, adicione:
   - `PAT` — o token gerado no passo 1. Marcar como **Secret**.
   - `MCP_SECRET` — uma string aleatória (ex: gerada com um gerenciador de senhas), usada como
     parte da URL. Marcar como **Secret**.
2. Salve. Não precisa redeploy manual — o Worker lê os secrets em runtime.

### 5. Apontar um domínio próprio (opcional, mas recomendado)

1. Em **Settings > Domains & Routes > Add > Domain**.
2. Escolha a zona (ex: `alexcordeiro.dev`) e defina o subdomínio (ex: `mcp-git`).
3. O Cloudflare emite certificado SSL automaticamente. Em poucos minutos o Worker responde em
   `https://mcp-git.alexcordeiro.dev`.

### 6. Testar antes de conectar ao Claude

Sem o secret certo, a rota deve responder `401 Unauthorized`:

```
GET https://mcp-git.alexcordeiro.dev/secret-errado/mcp
→ Unauthorized
```

Com o secret certo mas sem ser um POST, deve responder `405 Method not allowed` (confirma que
o secret bateu e passou da checagem de autenticação):

```
GET https://mcp-git.alexcordeiro.dev/<MCP_SECRET>/mcp
→ Method not allowed
```

### 7. Adicionar como custom connector no Claude

1. Em [claude.ai/settings/connectors](https://claude.ai/settings/connectors), clique em
   **Adicionar > Adicionar conector personalizado**.
2. **Nome**: algo identificável (ex: `MCP Git (alexcordeiro.dev)`).
3. **URL do servidor MCP remoto**: `https://mcp-git.alexcordeiro.dev/<MCP_SECRET>/mcp` — troque
   `<MCP_SECRET>` pelo valor real configurado no passo 4. **Confira visualmente antes de colar**
   que o campo não foi preenchido com outra coisa (ex: um gerenciador de senhas às vezes cola uma
   referência interna em vez do texto puro — o campo deve ter só a URL, nada de
   `data:application/...`).
4. Deixe **OAuth Client ID/Secret** vazios (não usamos OAuth, a autenticação é via URL).
5. Clique em **Adicionar** e depois em **Vincular**.
6. Se aparecer erro ao vincular, o mais comum é o secret da URL não bater com o `MCP_SECRET`
   salvo no Cloudflare — confira os dois valores.
7. Depois de vinculado, em **Permissões de ferramentas**, todas as 6 ferramentas vêm com
   **"Requer aprovação"** por padrão — nada executa sem confirmação manual antes de cada chamada.

### 8. Validar

Peça pro Claude chamar a ferramenta `whoami`. Deve retornar o `login`, `name` e `id` da conta do
GitHub dona do token — confirmando que a cadeia completa (Claude → Worker → GitHub) está
funcionando.

## Atualizando o código

Basta editar `worker.js` (e/ou `wrangler.toml`) neste repositório e dar push na `main`. O
Cloudflare Workers Builds detecta o commit, builda e faz o deploy automaticamente — sem precisar
colar código manualmente no editor do painel.

## Limitações conhecidas

- `push_files` cria um novo commit a partir do `HEAD` da branch no momento da chamada; não
  faz merge de conflitos — se o arquivo mudou entre a leitura e a escrita, o commit pode
  sobrescrever mudanças concorrentes.
- Não há suporte a branches protegidas, PRs ou revisão — as ferramentas escrevem direto na
  branch indicada (`main` por padrão).
- O `MCP_SECRET` não expira nem tem rotação automática. Se vazar, é preciso trocar o valor no
  Cloudflare e atualizar a URL no custom connector do Claude.
