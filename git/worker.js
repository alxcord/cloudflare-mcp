// MCP Worker - escrita real no GitHub via Cloudflare Workers
// Arquivo unico, sem build/npm. Colar direto no editor do painel Cloudflare.
//
// Secrets necessarios (aba Settings > Variables and Secrets do Worker):
//   PAT         - GitHub fine-grained personal access token (Contents: Read and write)
//   MCP_SECRET  - string aleatoria usada como segmento da URL
//
// Rota esperada: https://mcp.alexcordeiro.dev/<MCP_SECRET>/mcp

const GITHUB_API = 'https://api.github.com';

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

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

async function callTool(env, name, args) {
  switch (name) {
    case 'whoami': return toolWhoami(env);
    case 'list_dir': return toolListDir(env, args);
    case 'read_file': return toolReadFile(env, args);
    case 'write_file': return toolWriteFile(env, args);
    case 'delete_file': return toolDeleteFile(env, args);
    case 'push_files': return toolPushFiles(env, args);
    default: throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

async function handleRpc(env, body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alexcordeiro-github-mcp', version: '1.0.0' }
    });
  }

  if (method === 'notifications/initialized') {
    return null; // notificacao, sem resposta
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = await callTool(env, name, args || {});
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      });
    } catch (e) {
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // [secret, 'mcp']

    if (parts.length !== 2 || parts[1] !== 'mcp') {
      return new Response('Not found', { status: 404 });
    }
    const [secret] = parts;
    if (!env.MCP_SECRET || secret !== env.MCP_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const isBatch = Array.isArray(body);
    const messages = isBatch ? body : [body];

    const results = [];
    for (const msg of messages) {
      const result = await handleRpc(env, msg);
      if (result) results.push(result);
    }

    if (results.length === 0) {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify(isBatch ? results : results[0]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
