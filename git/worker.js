// MCP Worker - leitura e escrita real no GitHub via Cloudflare Workers
// Arquivo unico, sem build/npm.
//
// Secrets necessarios (aba Settings > Variables and Secrets do Worker):
//   PAT         - GitHub fine-grained personal access token
//                 (Contents: Read and write, Pull requests: Read and write,
//                  Issues: Read and write, Actions: Read-only, Pages: Read-only)
//   MCP_SECRET  - usado como (a) senha de aprovacao na tela /authorize e (b) chave de assinatura
//                 HMAC dos tokens OAuth emitidos por este Worker. NAO viaja mais na URL.
//
// Autenticacao: OAuth 2.1 + PKCE, sem estado (stateless) - nada e gravado em banco/KV. O
// "codigo de autorizacao" e o "access token" sao JWTs assinados com MCP_SECRET; validar = so
// conferir assinatura e validade. Para revogar tudo de uma vez, basta trocar o MCP_SECRET.
//
// Rotas:
//   GET  /.well-known/oauth-authorization-server   metadata OAuth
//   GET  /authorize                                 tela de aprovacao (pede o MCP_SECRET 1x)
//   POST /token                                      troca code por access_token
//   POST /mcp                                        endpoint MCP (Authorization: Bearer <token>)
//
// As ferramentas sao dedicadas por operacao (whoami, list_dir, read_file, write_file,
// push_files, delete_file, e o bloco de branches e pull requests), diferente do mcp-wger que
// expoe ferramentas genericas de REST: a parte da API do GitHub usada aqui e pequena, estavel e
// bem conhecida, entao vale a pena o Worker saber exatamente o que cada operacao faz (inclusive
// orquestrar a Git Trees API no push_files, que sao 5 chamadas encadeadas).

const GITHUB_API = 'https://api.github.com';
const ISSUER = 'https://mcp-git.alexcordeiro.dev';
const AUTH_CODE_TTL = 60;              // segundos - codigo de autorizacao e de uso unico e rapido
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 dias
const MERGE_METHODS = ['merge', 'squash', 'rebase'];
const REVIEW_EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const DIFF_MAX_CHARS = 60000;          // corta diffs gigantes antes de devolver ao Claude
const ISSUE_STATES = ['open', 'closed', 'all'];

// ---------- JSON-RPC helpers ----------

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------- base64url + JWT (HS256) sem nenhuma lib externa ----------

function b64urlEncode(bytes) {
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlEncodeStr(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}
function b64urlDecodeToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function b64urlDecodeToStr(b64url) {
  return new TextDecoder().decode(b64urlDecodeToBytes(b64url));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64urlEncodeStr(JSON.stringify(header));
  const payloadB64 = b64urlEncodeStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = b64urlEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('JWT malformado');
  const [headerB64, payloadB64, sigB64] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecodeToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('Assinatura invalida');
  const payload = JSON.parse(b64urlDecodeToStr(payloadB64));
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) {
    throw new Error('Token expirado');
  }
  return payload;
}

// ---------- PKCE (S256) ----------

async function sha256B64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64urlEncode(new Uint8Array(digest));
}

// ---------- Tools ----------

const TOOLS = [
  {
    name: 'whoami',
    description: 'Retorna o usuario do GitHub autenticado pelo token configurado.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_dir',
    description: 'Lista arquivos e pastas de um diretorio de um repo do GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string', description: 'Caminho do diretorio, vazio para a raiz' },
        ref: { type: 'string', description: 'Branch, tag ou SHA (opcional)' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'read_file',
    description: 'Le o conteudo de um arquivo de um repo do GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        ref: { type: 'string' }
      },
      required: ['owner', 'repo', 'path']
    }
  },
  {
    name: 'write_file',
    description: 'Cria ou atualiza um unico arquivo em um repo do GitHub (um commit).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string', description: 'Novo conteudo do arquivo, texto puro (UTF-8)' },
        message: { type: 'string', description: 'Mensagem do commit' },
        branch: { type: 'string' }
      },
      required: ['owner', 'repo', 'path', 'content', 'message']
    }
  },
  {
    name: 'push_files',
    description: 'Cria ou atualiza varios arquivos em um unico commit num repo do GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        message: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      required: ['owner', 'repo', 'message', 'files']
    }
  },
  {
    name: 'delete_file',
    description: 'Apaga um unico arquivo de um repo do GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' }
      },
      required: ['owner', 'repo', 'path', 'message']
    }
  },
  {
    name: 'list_branches',
    description: 'Lista as branches de um repo do GitHub, com o SHA do ultimo commit de cada uma.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        per_page: { type: 'number', description: 'Quantas branches trazer (padrao 100, maximo 100)' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'create_branch',
    description: 'Cria uma nova branch em um repo do GitHub a partir de outra branch ou de um commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string', description: 'Nome da branch nova' },
        from: { type: 'string', description: 'Branch ou SHA de origem (padrao: branch default do repo)' }
      },
      required: ['owner', 'repo', 'branch']
    }
  },
  {
    name: 'delete_branch',
    description: 'Apaga uma branch remota de um repo do GitHub. Nunca apaga a branch default.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' }
      },
      required: ['owner', 'repo', 'branch']
    }
  },
  {
    name: 'list_pull_requests',
    description: 'Lista os pull requests de um repo do GitHub, abertos, fechados ou todos.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', description: 'open, closed ou all (padrao: open)' },
        base: { type: 'string', description: 'Filtra por branch de destino' },
        head: { type: 'string', description: 'Filtra por branch de origem, formato owner:branch' },
        per_page: { type: 'number', description: 'Quantos PRs trazer (padrao 30, maximo 100)' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'get_pull_request',
    description: 'Retorna os detalhes de um pull request: titulo, descricao, estado, branches, se da para mergear e quantos arquivos mudaram.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number', description: 'Numero do pull request' }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'get_pull_request_diff',
    description: 'Retorna o diff unificado de um pull request, para revisar o que mudou antes de comentar, aprovar ou mergear.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        max_chars: { type: 'number', description: 'Tamanho maximo do diff devolvido (padrao 60000)' }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'create_pull_request',
    description: 'Abre um novo pull request em um repo do GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string', description: 'Branch de origem, com as mudancas' },
        base: { type: 'string', description: 'Branch de destino (padrao: branch default do repo)' },
        body: { type: 'string', description: 'Descricao do PR' },
        draft: { type: 'boolean', description: 'Abrir como rascunho (padrao false)' }
      },
      required: ['owner', 'repo', 'title', 'head']
    }
  },
  {
    name: 'update_pull_request',
    description: 'Altera titulo, descricao, branch base ou estado (open/closed) de um pull request existente.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string' },
        state: { type: 'string', description: 'open ou closed' }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'merge_pull_request',
    description: 'Faz o merge de um pull request. O metodo pode ser merge, squash ou rebase.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        method: { type: 'string', description: 'merge, squash ou rebase (padrao: squash)' },
        commit_title: { type: 'string' },
        commit_message: { type: 'string' }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'comment_pull_request',
    description: 'Escreve um comentario geral na conversa de um pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        body: { type: 'string' }
      },
      required: ['owner', 'repo', 'number', 'body']
    }
  },
  {
    name: 'review_pull_request',
    description: 'Cria uma revisao em um pull request, com comentario geral e, se quiser, comentarios em linhas especificas do diff. O evento pode ser COMMENT, APPROVE ou REQUEST_CHANGES.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        event: { type: 'string', description: 'COMMENT, APPROVE ou REQUEST_CHANGES (padrao: COMMENT)' },
        body: { type: 'string', description: 'Texto geral da revisao' },
        comments: {
          type: 'array',
          description: 'Comentarios em linhas especificas do diff',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Caminho do arquivo' },
              line: { type: 'number', description: 'Linha no arquivo depois da mudanca' },
              body: { type: 'string' },
              side: { type: 'string', description: 'RIGHT (padrao) ou LEFT' }
            },
            required: ['path', 'line', 'body']
          }
        }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'list_issues',
    description: 'Lista as issues de um repo do GitHub, abertas, fechadas ou todas. Nao inclui pull requests na lista.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', description: 'open, closed ou all (padrao: open)' },
        labels: { type: 'string', description: 'Lista de labels separadas por virgula' },
        per_page: { type: 'number', description: 'Quantas issues trazer (padrao 30, maximo 100)' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'get_issue',
    description: 'Retorna os detalhes de uma issue: titulo, descricao, estado, labels e responsaveis.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'create_issue',
    description: 'Abre uma nova issue em um repo do GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } }
      },
      required: ['owner', 'repo', 'title']
    }
  },
  {
    name: 'update_issue',
    description: 'Altera titulo, descricao, estado (open/closed), labels ou responsaveis de uma issue existente.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        title: { type: 'string' },
        body: { type: 'string' },
        state: { type: 'string', description: 'open ou closed' },
        labels: { type: 'array', items: { type: 'string' } },
        assignees: { type: 'array', items: { type: 'string' } }
      },
      required: ['owner', 'repo', 'number']
    }
  },
  {
    name: 'comment_issue',
    description: 'Escreve um comentario em uma issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        body: { type: 'string' }
      },
      required: ['owner', 'repo', 'number', 'body']
    }
  },
  {
    name: 'list_workflow_runs',
    description: 'Lista execucoes de workflow (Actions) de um repo, mais recentes primeiro.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        workflow: { type: 'string', description: 'Nome do arquivo do workflow (ex: deploy.yml) ou o id numerico, opcional' },
        branch: { type: 'string' },
        status: { type: 'string', description: 'queued, in_progress, completed, success, failure, etc (opcional)' },
        per_page: { type: 'number', description: 'Quantas execucoes trazer (padrao 20, maximo 100)' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'get_workflow_run',
    description: 'Retorna os detalhes de uma execucao de workflow: status, conclusao, branch, commit e duracao.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        run_id: { type: 'number' }
      },
      required: ['owner', 'repo', 'run_id']
    }
  },
  {
    name: 'list_workflow_run_jobs',
    description: 'Lista os jobs de uma execucao de workflow, com os steps de cada um e onde falhou, se falhou.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        run_id: { type: 'number' }
      },
      required: ['owner', 'repo', 'run_id']
    }
  },
  {
    name: 'get_pages_site',
    description: 'Retorna a configuracao do GitHub Pages de um repo: URL publicada, status, source (branch/pasta) e se e um dominio customizado.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'get_pages_build_status',
    description: 'Retorna o status do ultimo build/deploy do GitHub Pages: sucesso, erro (com mensagem) ou construindo.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  }
];

async function gh(env, path, opts = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${env.PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'alexcordeiro-mcp-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) ? data.message : `GitHub API error ${res.status}`;
    throw new Error(`${res.status} ${msg}`);
  }
  return data;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}
function b64decode(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function getRefSha(env, owner, repo, branch) {
  const ref = await gh(env, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  return ref.object.sha;
}

async function getDefaultBranch(env, owner, repo) {
  const info = await gh(env, `/repos/${owner}/${repo}`);
  return info.default_branch;
}

async function toolWhoami(env) {
  const me = await gh(env, '/user');
  return { login: me.login, name: me.name, id: me.id };
}

async function toolListDir(env, args) {
  const { owner, repo, path = '', ref } = args;
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${q}`);
  if (!Array.isArray(data)) {
    return [{ name: data.name, path: data.path, type: data.type, size: data.size }];
  }
  return data.map(d => ({ name: d.name, path: d.path, type: d.type, size: d.size }));
}

async function toolReadFile(env, args) {
  const { owner, repo, path, ref } = args;
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${q}`);
  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} nao e um arquivo`);
  }
  return { path: data.path, sha: data.sha, content: b64decode(data.content) };
}

async function toolWriteFile(env, args) {
  const { owner, repo, path, content, message, branch = 'main' } = args;
  let sha;
  try {
    const existing = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    if (!Array.isArray(existing)) sha = existing.sha;
  } catch (e) {
    // arquivo ainda nao existe - ok, sera criado
  }
  const body = {
    message,
    content: b64encode(content),
    branch,
    ...(sha ? { sha } : {})
  };
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
  return { path, commit: data.commit && data.commit.sha };
}

async function toolDeleteFile(env, args) {
  const { owner, repo, path, message, branch = 'main' } = args;
  const existing = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
  if (Array.isArray(existing)) throw new Error(`${path} nao e um arquivo`);
  const data = await gh(env, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha: existing.sha, branch })
  });
  return { path, commit: data.commit && data.commit.sha };
}

async function toolPushFiles(env, args) {
  const { owner, repo, branch = 'main', message, files } = args;
  const baseSha = await getRefSha(env, owner, repo, branch);
  const baseCommit = await gh(env, `/repos/${owner}/${repo}/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const blobs = [];
  for (const f of files) {
    const blob = await gh(env, `/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' })
    });
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(env, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: blobs })
  });

  const newCommit = await gh(env, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] })
  });

  await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha })
  });

  return { commit: newCommit.sha, files: files.map(f => f.path) };
}

// ---------- Branches ----------

async function toolListBranches(env, args) {
  const { owner, repo, per_page = 100 } = args;
  const limit = Math.min(Math.max(Number(per_page) || 100, 1), 100);
  const data = await gh(env, `/repos/${owner}/${repo}/branches?per_page=${limit}`);
  const def = await getDefaultBranch(env, owner, repo);
  return data.map(b => ({
    name: b.name,
    sha: b.commit && b.commit.sha,
    protected: b.protected,
    default: b.name === def
  }));
}

async function toolCreateBranch(env, args) {
  const { owner, repo, branch, from } = args;
  const source = from || await getDefaultBranch(env, owner, repo);
  let sha;
  try {
    sha = await getRefSha(env, owner, repo, source);
  } catch (e) {
    // 'from' pode ter vindo como SHA de commit em vez de nome de branch
    sha = source;
  }
  const ref = await gh(env, `/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha })
  });
  return { branch, from: source, sha: ref.object.sha };
}

async function toolDeleteBranch(env, args) {
  const { owner, repo, branch } = args;
  const def = await getDefaultBranch(env, owner, repo);
  if (branch === def) {
    throw new Error(`${branch} e a branch default de ${owner}/${repo} e nao pode ser apagada`);
  }
  await gh(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: 'DELETE' });
  return { branch, deleted: true };
}

// ---------- Pull requests ----------

function summarizePr(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    head: pr.head && pr.head.ref,
    base: pr.base && pr.base.ref,
    author: pr.user && pr.user.login,
    url: pr.html_url
  };
}

async function toolListPullRequests(env, args) {
  const { owner, repo, state = 'open', base, head, per_page = 30 } = args;
  const limit = Math.min(Math.max(Number(per_page) || 30, 1), 100);
  const q = new URLSearchParams({ state, per_page: String(limit) });
  if (base) q.set('base', base);
  if (head) q.set('head', head);
  const data = await gh(env, `/repos/${owner}/${repo}/pulls?${q.toString()}`);
  return data.map(summarizePr);
}

async function toolGetPullRequest(env, args) {
  const { owner, repo, number } = args;
  const pr = await gh(env, `/repos/${owner}/${repo}/pulls/${number}`);
  return {
    ...summarizePr(pr),
    body: pr.body,
    merged: pr.merged,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable_state,
    changed_files: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions
  };
}

async function toolGetPullRequestDiff(env, args) {
  const { owner, repo, number, max_chars = DIFF_MAX_CHARS } = args;
  const limit = Math.max(Number(max_chars) || DIFF_MAX_CHARS, 1000);
  const raw = await gh(env, `/repos/${owner}/${repo}/pulls/${number}`, {
    headers: { 'Accept': 'application/vnd.github.v3.diff' }
  });
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (text.length > limit) {
    return { number, truncated: true, diff: `${text.slice(0, limit)}\n... [diff truncado em ${limit} caracteres]` };
  }
  return { number, truncated: false, diff: text };
}

async function toolCreatePullRequest(env, args) {
  const { owner, repo, title, head, base, body, draft = false } = args;
  const target = base || await getDefaultBranch(env, owner, repo);
  const pr = await gh(env, `/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, head, base: target, draft, ...(body ? { body } : {}) })
  });
  return summarizePr(pr);
}

async function toolUpdatePullRequest(env, args) {
  const { owner, repo, number, title, body, base, state } = args;
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (body !== undefined) patch.body = body;
  if (base !== undefined) patch.base = base;
  if (state !== undefined) {
    if (state !== 'open' && state !== 'closed') throw new Error(`Estado invalido: ${state}. Use open ou closed.`);
    patch.state = state;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('Nada para atualizar: informe title, body, base ou state');
  }
  const pr = await gh(env, `/repos/${owner}/${repo}/pulls/${number}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return summarizePr(pr);
}

async function toolMergePullRequest(env, args) {
  const { owner, repo, number, method = 'squash', commit_title, commit_message } = args;
  if (!MERGE_METHODS.includes(method)) {
    throw new Error(`Metodo de merge invalido: ${method}. Use ${MERGE_METHODS.join(', ')}.`);
  }
  const data = await gh(env, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({
      merge_method: method,
      ...(commit_title ? { commit_title } : {}),
      ...(commit_message ? { commit_message } : {})
    })
  });
  return { number, merged: data.merged, sha: data.sha, message: data.message };
}

async function toolCommentPullRequest(env, args) {
  const { owner, repo, number, body } = args;
  const c = await gh(env, `/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body })
  });
  return { id: c.id, url: c.html_url };
}

async function toolReviewPullRequest(env, args) {
  const { owner, repo, number, event = 'COMMENT', body, comments } = args;
  if (!REVIEW_EVENTS.includes(event)) {
    throw new Error(`Evento de revisao invalido: ${event}. Use ${REVIEW_EVENTS.join(', ')}.`);
  }
  const hasComments = Array.isArray(comments) && comments.length > 0;
  if ((event === 'COMMENT' || event === 'REQUEST_CHANGES') && !body && !hasComments) {
    throw new Error(`O evento ${event} exige um texto em body ou pelo menos um comentario em comments.`);
  }
  const payload = { event, ...(body ? { body } : {}) };
  if (hasComments) {
    payload.comments = comments.map(c => ({
      path: c.path,
      line: c.line,
      body: c.body,
      ...(c.side ? { side: c.side } : {})
    }));
  }
  const review = await gh(env, `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return { id: review.id, state: review.state, url: review.html_url };
}

// ---------- Issues ----------

function summarizeIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user && issue.user.login,
    labels: (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
    assignees: (issue.assignees || []).map(a => a.login),
    url: issue.html_url
  };
}

async function toolListIssues(env, args) {
  const { owner, repo, state = 'open', labels, per_page = 30 } = args;
  if (!ISSUE_STATES.includes(state)) {
    throw new Error(`Estado invalido: ${state}. Use ${ISSUE_STATES.join(', ')}.`);
  }
  const limit = Math.min(Math.max(Number(per_page) || 30, 1), 100);
  const q = new URLSearchParams({ state, per_page: String(limit) });
  if (labels) q.set('labels', labels);
  const data = await gh(env, `/repos/${owner}/${repo}/issues?${q.toString()}`);
  // a API de issues do GitHub tambem devolve pull requests; filtra fora
  return data.filter(i => !i.pull_request).map(summarizeIssue);
}

async function toolGetIssue(env, args) {
  const { owner, repo, number } = args;
  const issue = await gh(env, `/repos/${owner}/${repo}/issues/${number}`);
  if (issue.pull_request) throw new Error(`${owner}/${repo}#${number} e um pull request, nao uma issue`);
  return { ...summarizeIssue(issue), body: issue.body };
}

async function toolCreateIssue(env, args) {
  const { owner, repo, title, body, labels, assignees } = args;
  const issue = await gh(env, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title,
      ...(body ? { body } : {}),
      ...(labels ? { labels } : {}),
      ...(assignees ? { assignees } : {})
    })
  });
  return summarizeIssue(issue);
}

async function toolUpdateIssue(env, args) {
  const { owner, repo, number, title, body, state, labels, assignees } = args;
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (body !== undefined) patch.body = body;
  if (labels !== undefined) patch.labels = labels;
  if (assignees !== undefined) patch.assignees = assignees;
  if (state !== undefined) {
    if (state !== 'open' && state !== 'closed') throw new Error(`Estado invalido: ${state}. Use open ou closed.`);
    patch.state = state;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('Nada para atualizar: informe title, body, state, labels ou assignees');
  }
  const issue = await gh(env, `/repos/${owner}/${repo}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return summarizeIssue(issue);
}

async function toolCommentIssue(env, args) {
  const { owner, repo, number, body } = args;
  const c = await gh(env, `/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body })
  });
  return { id: c.id, url: c.html_url };
}

// ---------- Actions ----------

function summarizeWorkflowRun(run) {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    commit: run.head_sha,
    event: run.event,
    url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at
  };
}

async function toolListWorkflowRuns(env, args) {
  const { owner, repo, workflow, branch, status, per_page = 20 } = args;
  const limit = Math.min(Math.max(Number(per_page) || 20, 1), 100);
  const q = new URLSearchParams({ per_page: String(limit) });
  if (branch) q.set('branch', branch);
  if (status) q.set('status', status);
  const base = workflow
    ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`
    : `/repos/${owner}/${repo}/actions/runs`;
  const data = await gh(env, `${base}?${q.toString()}`);
  return (data.workflow_runs || []).map(summarizeWorkflowRun);
}

async function toolGetWorkflowRun(env, args) {
  const { owner, repo, run_id } = args;
  const run = await gh(env, `/repos/${owner}/${repo}/actions/runs/${run_id}`);
  return {
    ...summarizeWorkflowRun(run),
    run_attempt: run.run_attempt,
    run_started_at: run.run_started_at
  };
}

async function toolListWorkflowRunJobs(env, args) {
  const { owner, repo, run_id } = args;
  const data = await gh(env, `/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
  return (data.jobs || []).map(job => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    steps: (job.steps || []).map(s => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number
    }))
  }));
}

// ---------- Pages ----------

async function toolGetPagesSite(env, args) {
  const { owner, repo } = args;
  const site = await gh(env, `/repos/${owner}/${repo}/pages`);
  return {
    url: site.html_url || site.url,
    status: site.status,
    cname: site.cname,
    custom_404: site.custom_404,
    https_enforced: site.https_enforced,
    source: site.source
  };
}

async function toolGetPagesBuildStatus(env, args) {
  const { owner, repo } = args;
  const build = await gh(env, `/repos/${owner}/${repo}/pages/builds/latest`);
  return {
    status: build.status,
    error: build.error && build.error.message ? build.error.message : null,
    commit: build.commit,
    duration_ms: build.duration,
    created_at: build.created_at,
    updated_at: build.updated_at
  };
}

async function callTool(env, name, args) {
  switch (name) {
    case 'whoami': return toolWhoami(env);
    case 'list_dir': return toolListDir(env, args);
    case 'read_file': return toolReadFile(env, args);
    case 'write_file': return toolWriteFile(env, args);
    case 'delete_file': return toolDeleteFile(env, args);
    case 'push_files': return toolPushFiles(env, args);
    case 'list_branches': return toolListBranches(env, args);
    case 'create_branch': return toolCreateBranch(env, args);
    case 'delete_branch': return toolDeleteBranch(env, args);
    case 'list_pull_requests': return toolListPullRequests(env, args);
    case 'get_pull_request': return toolGetPullRequest(env, args);
    case 'get_pull_request_diff': return toolGetPullRequestDiff(env, args);
    case 'create_pull_request': return toolCreatePullRequest(env, args);
    case 'update_pull_request': return toolUpdatePullRequest(env, args);
    case 'merge_pull_request': return toolMergePullRequest(env, args);
    case 'comment_pull_request': return toolCommentPullRequest(env, args);
    case 'review_pull_request': return toolReviewPullRequest(env, args);
    case 'list_issues': return toolListIssues(env, args);
    case 'get_issue': return toolGetIssue(env, args);
    case 'create_issue': return toolCreateIssue(env, args);
    case 'update_issue': return toolUpdateIssue(env, args);
    case 'comment_issue': return toolCommentIssue(env, args);
    case 'list_workflow_runs': return toolListWorkflowRuns(env, args);
    case 'get_workflow_run': return toolGetWorkflowRun(env, args);
    case 'list_workflow_run_jobs': return toolListWorkflowRunJobs(env, args);
    case 'get_pages_site': return toolGetPagesSite(env, args);
    case 'get_pages_build_status': return toolGetPagesBuildStatus(env, args);
    default: throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

// ---------- MCP JSON-RPC ----------

async function handleRpc(env, body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alexcordeiro-github-mcp', version: '2.2.0' }
    });
  }
  if (method === 'notifications/initialized') {
    return null;
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = await callTool(env, name, args || {});
      return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return jsonRpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// ---------- OAuth endpoints ----------

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

function metadataResponse() {
  return json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  });
}

function approveForm(params, error) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v ? String(v).replace(/"/g, '&quot;') : ''}">`)
    .join('\n    ');
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Autorizar acesso</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; color: #111; }
  h1 { font-size: 18px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 16px; margin: 12px 0; box-sizing: border-box; }
  button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
  .err { color: #b00020; font-size: 14px; }
</style></head>
<body>
  <h1>Autorizar acesso ao MCP Git</h1>
  <p>Cole o segredo (MCP_SECRET) para aprovar esta conexão ao GitHub.</p>
  ${error ? `<p class="err">${error}</p>` : ''}
  <form method="GET" action="/authorize">
    ${hidden}
    <input type="password" name="key" placeholder="MCP_SECRET" autofocus required>
    <button type="submit">Aprovar</button>
  </form>
</body></html>`;
}

async function handleAuthorize(env, url) {
  const p = url.searchParams;
  const client_id = p.get('client_id') || '';
  const redirect_uri = p.get('redirect_uri');
  const state = p.get('state') || '';
  const code_challenge = p.get('code_challenge');
  const code_challenge_method = p.get('code_challenge_method') || 'S256';
  const response_type = p.get('response_type') || 'code';
  const key = p.get('key');

  if (!redirect_uri || response_type !== 'code' || !code_challenge || code_challenge_method !== 'S256') {
    return html('Requisição OAuth inválida (faltam parâmetros obrigatórios ou method != S256).', 400);
  }

  const formParams = { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type };

  if (key === null) {
    return html(approveForm(formParams));
  }
  if (!env.MCP_SECRET || key !== env.MCP_SECRET) {
    return html(approveForm(formParams, 'Segredo incorreto. Tente de novo.'), 401);
  }

  const code = await signJWT({
    iss: ISSUER,
    aud: client_id,
    redirect_uri,
    code_challenge,
    typ: 'auth_code',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL
  }, env.MCP_SECRET);

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleToken(env, request) {
  const contentType = request.headers.get('Content-Type') || '';
  let params;
  if (contentType.includes('application/json')) {
    params = await request.json();
  } else {
    const form = await request.formData();
    params = Object.fromEntries(form.entries());
  }

  const { grant_type, code, redirect_uri, code_verifier, client_id } = params;

  if (grant_type !== 'authorization_code') {
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  if (!code || !redirect_uri || !code_verifier) {
    return json({ error: 'invalid_request' }, 400);
  }

  let payload;
  try {
    payload = await verifyJWT(code, env.MCP_SECRET);
  } catch (e) {
    return json({ error: 'invalid_grant', error_description: e.message }, 400);
  }
  if (payload.typ !== 'auth_code' || payload.redirect_uri !== redirect_uri) {
    return json({ error: 'invalid_grant' }, 400);
  }

  const computedChallenge = await sha256B64url(code_verifier);
  if (computedChallenge !== payload.code_challenge) {
    return json({ error: 'invalid_grant', error_description: 'PKCE code_verifier não confere' }, 400);
  }

  const accessToken = await signJWT({
    iss: ISSUER,
    aud: client_id || payload.aud,
    sub: 'alexcordeiro',
    typ: 'access_token',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL
  }, env.MCP_SECRET);

  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL
  });
}

async function requireBearer(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('missing bearer token');
  const payload = await verifyJWT(match[1], env.MCP_SECRET);
  if (payload.typ !== 'access_token') throw new Error('token type invalido');
  return payload;
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return metadataResponse();
    }

    if (url.pathname === '/authorize' && request.method === 'GET') {
      return handleAuthorize(env, url);
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      return handleToken(env, request);
    }

    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      try {
        await requireBearer(env, request);
      } catch (e) {
        return json({ error: 'invalid_token', error_description: e.message }, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${ISSUER}/.well-known/oauth-authorization-server"`
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json(jsonRpcError(null, -32700, 'Parse error'), 400);
      }

      const isBatch = Array.isArray(body);
      const messages = isBatch ? body : [body];
      const results = [];
      for (const msg of messages) {
        const result = await handleRpc(env, msg);
        if (result) results.push(result);
      }
      if (results.length === 0) return new Response(null, { status: 204 });
      return json(isBatch ? results : results[0]);
    }

    return new Response('Not found', { status: 404 });
  }
};
