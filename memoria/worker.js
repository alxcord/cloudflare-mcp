// MCP Worker — grafo de memória pessoal com Cloudflare D1
// Arquivo único, sem build/npm.
//
// Secrets necessários (Settings > Variables and Secrets do Worker):
//   MCP_SECRET  — chave de assinatura dos JWTs OAuth + senha da tela de aprovação
//   API_TOKEN   — Bearer token estático para a API REST (/api/*)
//
// D1 binding (wrangler.toml + Settings > Bindings do Worker):
//   DB          — banco criado com: wrangler d1 create mcp-memoria-db
//                 Copiar o database_id retornado e colar em wrangler.toml antes do primeiro push.
//
// Após o primeiro deploy bem-sucedido, inicializar as tabelas uma única vez:
//   curl -X POST https://mcp-memoria.<seu-dominio>/api/init \
//     -H "Authorization: Bearer <API_TOKEN>"
//
// Rotas OAuth (para o Claude via custom connector MCP):
//   GET  /.well-known/oauth-authorization-server  — metadata OAuth
//   GET  /authorize                                — tela de aprovação
//   POST /token                                    — troca code por access_token
//   POST /mcp                                      — endpoint MCP (Bearer JWT)
//
// Rotas REST (para scripts/automações, auth: Bearer <API_TOKEN>):
//   POST   /api/init               — cria tabelas (idempotente, rodar uma vez)
//   GET    /api/nodes              — lista/busca nós (?tipo=&nome=&limite=)
//   POST   /api/nodes              — grava nó
//   PATCH  /api/nodes/:id         — atualiza nó
//   DELETE /api/nodes/:id         — remove nó + arestas ligadas
//   POST   /api/edges              — grava aresta
//   DELETE /api/edges/:id         — remove aresta
//   GET    /api/query              — traversal (?origem=&via_relacao=&destino=&tipo=&limite=)

const AUTH_CODE_TTL = 60;
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 dias

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── base64url + JWT HS256 (sem libs externas) ─────────────────────────────────

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
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}
async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = b64urlEncodeStr(JSON.stringify(header));
  const p = b64urlEncodeStr(JSON.stringify(payload));
  const input = `${h}.${p}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}
async function verifyJWT(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('JWT malformado');
  const [h, p, sigB64] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC', key, b64urlDecodeToBytes(sigB64), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) throw new Error('Assinatura inválida');
  const payload = JSON.parse(b64urlDecodeToStr(p));
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) throw new Error('Token expirado');
  return payload;
}

// ── PKCE (S256) ───────────────────────────────────────────────────────────────

async function sha256B64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64urlEncode(new Uint8Array(digest));
}

// ── D1 — schema e helpers ─────────────────────────────────────────────────────

const INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS nodes (
    id            TEXT PRIMARY KEY,
    tipo          TEXT NOT NULL,
    nome          TEXT NOT NULL,
    atributos     TEXT NOT NULL DEFAULT '{}',
    criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_tipo ON nodes(tipo)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_nome ON nodes(nome)`,
  `CREATE TABLE IF NOT EXISTS edges (
    id           TEXT PRIMARY KEY,
    origem       TEXT NOT NULL,
    tipo_relacao TEXT NOT NULL,
    destino      TEXT NOT NULL,
    criado_em    TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_edges_origem ON edges(origem)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_destino ON edges(destino)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_tipo ON edges(tipo_relacao)`
];

async function dbInit(DB) {
  await DB.batch(INIT_SQL.map(sql => DB.prepare(sql)));
}

// ── MCP tools — definição ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'gravar_entidade',
    description: 'Cria ou atualiza um nó no grafo de memória. Se já existir um nó com o mesmo nome e tipo, mescla os atributos novos com os existentes. Use para registrar pessoas, artistas, livros, filmes, lugares, conceitos, gêneros musicais, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da entidade (ex: "Silva", "MPB", "Dom Casmurro")' },
        tipo: { type: 'string', description: 'Categoria da entidade (ex: "artista", "genero", "livro", "pessoa", "lugar", "filme")' },
        atributos: { type: 'object', description: 'Atributos livres do tipo da entidade (ex: {"decada": "1970", "pais": "BR", "nota": "recomendado por Joao"})' }
      },
      required: ['nome', 'tipo']
    }
  },
  {
    name: 'gravar_aresta',
    description: 'Cria uma relação entre dois nós existentes. Use nomes de entidades (não IDs). Se a aresta já existir, ignora (idempotente). Ambas as entidades devem existir — use gravar_entidade primeiro se necessário.',
    inputSchema: {
      type: 'object',
      properties: {
        origem: { type: 'string', description: 'Nome da entidade de origem' },
        tipo_relacao: { type: 'string', description: 'Tipo da relação em maiúsculas (ex: "GOSTEI", "GENERO", "AUTOR", "INDICADO_POR", "MORA_EM", "TRABALHA_EM")' },
        destino: { type: 'string', description: 'Nome da entidade de destino' }
      },
      required: ['origem', 'tipo_relacao', 'destino']
    }
  },
  {
    name: 'consultar',
    description: 'Busca nós e arestas no grafo. Para busca simples, use tipo e/ou nome. Para traversal ("artistas de MPB", "livros do mesmo autor"), use via_relacao junto com origem ou destino.',
    inputSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Filtra nós pelo tipo (ex: "artista", "livro")' },
        nome: { type: 'string', description: 'Busca por nome parcial, case-insensitive (ex: "sil" encontra "Silva")' },
        via_relacao: { type: 'string', description: 'Tipo de relação para traversal (ex: "GENERO"). Requer origem ou destino.' },
        origem: { type: 'string', description: 'Nome do nó de origem para traversal de arestas' },
        destino: { type: 'string', description: 'Nome do nó de destino para traversal reverso' },
        limite: { type: 'number', description: 'Máximo de resultados retornados (padrão 50, máximo 200)' }
      }
    }
  },
  {
    name: 'remover_entidade',
    description: 'Remove um nó do grafo pelo nome e tipo, junto com todas as arestas ligadas a ele (entrada e saída).',
    inputSchema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da entidade a remover' },
        tipo: { type: 'string', description: 'Tipo da entidade (necessário para evitar ambiguidade entre entidades de mesmo nome)' }
      },
      required: ['nome', 'tipo']
    }
  }
];

// ── MCP tools — implementação ─────────────────────────────────────────────────

async function toolGravarEntidade(DB, { nome, tipo, atributos = {} }) {
  const existing = await DB.prepare(
    'SELECT id, atributos FROM nodes WHERE nome = ? AND tipo = ?'
  ).bind(nome, tipo).first();

  if (existing) {
    const merged = { ...JSON.parse(existing.atributos || '{}'), ...atributos };
    await DB.prepare(
      "UPDATE nodes SET atributos = ?, atualizado_em = datetime('now') WHERE id = ?"
    ).bind(JSON.stringify(merged), existing.id).run();
    return { acao: 'atualizado', id: existing.id, nome, tipo, atributos: merged };
  }

  const id = crypto.randomUUID();
  await DB.prepare(
    'INSERT INTO nodes (id, tipo, nome, atributos) VALUES (?, ?, ?, ?)'
  ).bind(id, tipo, nome, JSON.stringify(atributos)).run();
  return { acao: 'criado', id, nome, tipo, atributos };
}

async function toolGravarAresta(DB, { origem, tipo_relacao, destino }) {
  const nOrigem = await DB.prepare(
    'SELECT id FROM nodes WHERE nome = ?'
  ).bind(origem).first();
  if (!nOrigem) throw new Error(`Entidade de origem não encontrada: "${origem}". Use gravar_entidade primeiro.`);

  const nDestino = await DB.prepare(
    'SELECT id FROM nodes WHERE nome = ?'
  ).bind(destino).first();
  if (!nDestino) throw new Error(`Entidade de destino não encontrada: "${destino}". Use gravar_entidade primeiro.`);

  const existing = await DB.prepare(
    'SELECT id FROM edges WHERE origem = ? AND tipo_relacao = ? AND destino = ?'
  ).bind(nOrigem.id, tipo_relacao, nDestino.id).first();
  if (existing) return { acao: 'ja_existe', id: existing.id, origem, tipo_relacao, destino };

  const id = crypto.randomUUID();
  await DB.prepare(
    'INSERT INTO edges (id, origem, tipo_relacao, destino) VALUES (?, ?, ?, ?)'
  ).bind(id, nOrigem.id, tipo_relacao, nDestino.id).run();
  return { acao: 'criado', id, origem, tipo_relacao, destino };
}

function parseNodes(rows) {
  return rows.map(r => ({
    id: r.id, tipo: r.tipo, nome: r.nome,
    atributos: JSON.parse(r.atributos || '{}'),
    ...(r.tipo_relacao ? { via: r.tipo_relacao } : {})
  }));
}

async function toolConsultar(DB, { tipo, nome, via_relacao, origem, destino, limite = 50 }) {
  const lim = Math.min(Number(limite) || 50, 200);

  // Traversal direto: origem --[via_relacao]--> ?
  if (via_relacao && origem) {
    const nOrigem = await DB.prepare('SELECT id FROM nodes WHERE nome = ?').bind(origem).first();
    if (!nOrigem) return { nodes: [], info: `Nó "${origem}" não encontrado` };
    const binds = [nOrigem.id, via_relacao];
    const tipoClause = tipo ? 'AND n.tipo = ?' : '';
    if (tipo) binds.push(tipo);
    binds.push(lim);
    const rows = await DB.prepare(
      `SELECT n.id, n.tipo, n.nome, n.atributos, e.tipo_relacao
       FROM edges e JOIN nodes n ON n.id = e.destino
       WHERE e.origem = ? AND e.tipo_relacao = ? ${tipoClause} LIMIT ?`
    ).bind(...binds).all();
    return { nodes: parseNodes(rows.results), query: { origem, via_relacao, tipo } };
  }

  // Traversal reverso: ? --[via_relacao]--> destino
  if (via_relacao && destino) {
    const nDestino = await DB.prepare('SELECT id FROM nodes WHERE nome = ?').bind(destino).first();
    if (!nDestino) return { nodes: [], info: `Nó "${destino}" não encontrado` };
    const binds = [nDestino.id, via_relacao];
    const tipoClause = tipo ? 'AND n.tipo = ?' : '';
    if (tipo) binds.push(tipo);
    binds.push(lim);
    const rows = await DB.prepare(
      `SELECT n.id, n.tipo, n.nome, n.atributos, e.tipo_relacao
       FROM edges e JOIN nodes n ON n.id = e.origem
       WHERE e.destino = ? AND e.tipo_relacao = ? ${tipoClause} LIMIT ?`
    ).bind(...binds).all();
    return { nodes: parseNodes(rows.results), query: { destino, via_relacao, tipo } };
  }

  // Busca simples por tipo e/ou nome
  const clauses = [];
  const binds = [];
  if (tipo) { clauses.push('tipo = ?'); binds.push(tipo); }
  if (nome) { clauses.push('nome LIKE ?'); binds.push(`%${nome}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  binds.push(lim);
  const rows = await DB.prepare(
    `SELECT id, tipo, nome, atributos FROM nodes ${where} ORDER BY atualizado_em DESC LIMIT ?`
  ).bind(...binds).all();
  return { nodes: parseNodes(rows.results), total: rows.results.length };
}

async function toolRemoverEntidade(DB, { nome, tipo }) {
  const node = await DB.prepare(
    'SELECT id FROM nodes WHERE nome = ? AND tipo = ?'
  ).bind(nome, tipo).first();
  if (!node) throw new Error(`Entidade não encontrada: "${nome}" (tipo: ${tipo})`);

  const edgesResult = await DB.prepare(
    'DELETE FROM edges WHERE origem = ? OR destino = ?'
  ).bind(node.id, node.id).run();
  await DB.prepare('DELETE FROM nodes WHERE id = ?').bind(node.id).run();

  return {
    acao: 'removido', id: node.id, nome, tipo,
    arestas_removidas: edgesResult.meta?.changes ?? 0
  };
}

async function callTool(DB, name, args) {
  switch (name) {
    case 'gravar_entidade':  return toolGravarEntidade(DB, args);
    case 'gravar_aresta':    return toolGravarAresta(DB, args);
    case 'consultar':        return toolConsultar(DB, args);
    case 'remover_entidade': return toolRemoverEntidade(DB, args);
    default: throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

// ── MCP JSON-RPC handler ──────────────────────────────────────────────────────

async function handleRpc(env, body) {
  const { id, method, params } = body;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alexcordeiro-memoria-mcp', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return jsonRpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = await callTool(env.DB, name, args || {});
      return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return jsonRpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// ── REST API handler ──────────────────────────────────────────────────────────

function requireApiToken(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || !env.API_TOKEN || match[1] !== env.API_TOKEN) {
    throw new Error('unauthorized');
  }
}

async function handleApi(env, request, url) {
  try { requireApiToken(env, request); }
  catch { return jsonResponse({ error: 'unauthorized' }, 401); }

  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;

  // POST /api/init
  if (path === '/init' && method === 'POST') {
    await dbInit(env.DB);
    return jsonResponse({ ok: true, message: 'Tabelas criadas (ou já existiam)' });
  }
  // GET /api/nodes
  if (path === '/nodes' && method === 'GET') {
    const result = await toolConsultar(env.DB, {
      tipo: url.searchParams.get('tipo') || undefined,
      nome: url.searchParams.get('nome') || undefined,
      limite: Number(url.searchParams.get('limite')) || 50
    });
    return jsonResponse(result);
  }
  // POST /api/nodes
  if (path === '/nodes' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!body.nome || !body.tipo) return jsonResponse({ error: 'nome e tipo são obrigatórios' }, 400);
    const result = await toolGravarEntidade(env.DB, { nome: body.nome, tipo: body.tipo, atributos: body.atributos || {} });
    return jsonResponse(result, result.acao === 'criado' ? 201 : 200);
  }

  const nodeMatch = path.match(/^\/nodes\/([^/]+)$/);
  // PATCH /api/nodes/:id
  if (nodeMatch && method === 'PATCH') {
    const id = nodeMatch[1];
    const node = await env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first();
    if (!node) return jsonResponse({ error: 'Nó não encontrado' }, 404);
    const body = await request.json().catch(() => ({}));
    const merged = { ...JSON.parse(node.atributos || '{}'), ...(body.atributos || {}) };
    const nome = body.nome || node.nome;
    const tipo = body.tipo || node.tipo;
    await env.DB.prepare(
      "UPDATE nodes SET nome = ?, tipo = ?, atributos = ?, atualizado_em = datetime('now') WHERE id = ?"
    ).bind(nome, tipo, JSON.stringify(merged), id).run();
    return jsonResponse({ id, nome, tipo, atributos: merged });
  }
  // DELETE /api/nodes/:id
  if (nodeMatch && method === 'DELETE') {
    const id = nodeMatch[1];
    const node = await env.DB.prepare('SELECT nome, tipo FROM nodes WHERE id = ?').bind(id).first();
    if (!node) return jsonResponse({ error: 'Nó não encontrado' }, 404);
    const result = await toolRemoverEntidade(env.DB, { nome: node.nome, tipo: node.tipo });
    return jsonResponse(result);
  }

  // POST /api/edges
  if (path === '/edges' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!body.origem || !body.tipo_relacao || !body.destino) {
      return jsonResponse({ error: 'origem, tipo_relacao e destino são obrigatórios' }, 400);
    }
    const result = await toolGravarAresta(env.DB, body);
    return jsonResponse(result, result.acao === 'criado' ? 201 : 200);
  }

  const edgeMatch = path.match(/^\/edges\/([^/]+)$/);
  // DELETE /api/edges/:id
  if (edgeMatch && method === 'DELETE') {
    const id = edgeMatch[1];
    const edge = await env.DB.prepare('SELECT id FROM edges WHERE id = ?').bind(id).first();
    if (!edge) return jsonResponse({ error: 'Aresta não encontrada' }, 404);
    await env.DB.prepare('DELETE FROM edges WHERE id = ?').bind(id).run();
    return jsonResponse({ acao: 'removido', id });
  }

  // GET /api/query
  if (path === '/query' && method === 'GET') {
    const result = await toolConsultar(env.DB, {
      tipo:        url.searchParams.get('tipo')        || undefined,
      nome:        url.searchParams.get('nome')        || undefined,
      via_relacao: url.searchParams.get('via_relacao') || undefined,
      origem:      url.searchParams.get('origem')      || undefined,
      destino:     url.searchParams.get('destino')     || undefined,
      limite:      Number(url.searchParams.get('limite')) || 50
    });
    return jsonResponse(result);
  }

  return jsonResponse({ error: 'Rota não encontrada' }, 404);
}

// ── OAuth 2.1 + PKCE ──────────────────────────────────────────────────────────

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...extra }
  });
}

function approveForm(params, error) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v || '').replace(/"/g, '&quot;')}">`)
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
  <h1>Autorizar acesso ao MCP Memória</h1>
  <p>Cole o segredo (MCP_SECRET) para aprovar esta conexão.</p>
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
  const redirect_uri = p.get('redirect_uri');
  const code_challenge = p.get('code_challenge');
  const code_challenge_method = p.get('code_challenge_method') || 'S256';
  const response_type = p.get('response_type') || 'code';
  const client_id = p.get('client_id') || '';
  const state = p.get('state') || '';
  const key = p.get('key');

  if (!redirect_uri || response_type !== 'code' || !code_challenge || code_challenge_method !== 'S256') {
    return htmlResponse('Requisição OAuth inválida.', 400);
  }

  const issuer = url.origin;
  const formParams = { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type };

  if (key === null) return htmlResponse(approveForm(formParams));
  if (!env.MCP_SECRET || key !== env.MCP_SECRET) return htmlResponse(approveForm(formParams, 'Segredo incorreto. Tente de novo.'), 401);

  const code = await signJWT({
    iss: issuer, aud: client_id, redirect_uri, code_challenge,
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
    params = Object.fromEntries((await request.formData()).entries());
  }
  const { grant_type, code, redirect_uri, code_verifier, client_id } = params;
  if (grant_type !== 'authorization_code') return jsonResponse({ error: 'unsupported_grant_type' }, 400);
  if (!code || !redirect_uri || !code_verifier) return jsonResponse({ error: 'invalid_request' }, 400);

  let payload;
  try { payload = await verifyJWT(code, env.MCP_SECRET); }
  catch (e) { return jsonResponse({ error: 'invalid_grant', error_description: e.message }, 400); }

  if (payload.typ !== 'auth_code' || payload.redirect_uri !== redirect_uri) {
    return jsonResponse({ error: 'invalid_grant' }, 400);
  }
  if (await sha256B64url(code_verifier) !== payload.code_challenge) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE code_verifier não confere' }, 400);
  }

  const issuer = new URL(request.url).origin;
  const accessToken = await signJWT({
    iss: issuer, aud: client_id || payload.aud, sub: 'user',
    typ: 'access_token',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL
  }, env.MCP_SECRET);

  return jsonResponse({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL });
}

async function requireBearerJWT(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('missing bearer token');
  const payload = await verifyJWT(match[1], env.MCP_SECRET);
  if (payload.typ !== 'access_token') throw new Error('token type inválido');
  return payload;
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const issuer = url.origin;

    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return jsonResponse({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (url.pathname === '/authorize' && request.method === 'GET') {
      return handleAuthorize(env, url);
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      return handleToken(env, request);
    }
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(env, request, url); }
      catch (e) { return jsonResponse({ error: e.message }, 500); }
    }
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try { await requireBearerJWT(env, request); }
      catch (e) {
        return jsonResponse({ error: 'invalid_token', error_description: e.message }, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-authorization-server"`
        });
      }
      let body;
      try { body = await request.json(); }
      catch { return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), 400); }

      const isBatch = Array.isArray(body);
      const messages = isBatch ? body : [body];
      const results = [];
      for (const msg of messages) {
        const result = await handleRpc(env, msg);
        if (result) results.push(result);
      }
      if (results.length === 0) return new Response(null, { status: 204 });
      return jsonResponse(isBatch ? results : results[0]);
    }
    return new Response('Not found', { status: 404 });
  }
};
