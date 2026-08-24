// MCP Worker - leitura e escrita real na API do Habitica (habitica.com) via Cloudflare Workers
// Arquivo unico, sem build/npm.
//
// Secrets necessarios (aba Settings > Variables and Secrets do Worker):
//   HABITICA_USER_ID    - User ID da conta Habitica (Settings > API no site, ou Settings >
//                          Authentication no app). Nao e segredo por natureza, mas fica como
//                          secret aqui por simplicidade e porque acompanha o token.
//   HABITICA_API_TOKEN  - API Token da mesma tela. Este sim e sensivel, equivalente a senha.
//   MCP_SECRET          - usado como (a) senha de aprovacao na tela /authorize e (b) chave de
//                          assinatura HMAC dos tokens OAuth emitidos por este Worker. Nao viaja
//                          na URL.
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
// A API v3 do Habitica exige tres headers em toda chamada autenticada: x-api-user, x-api-key e
// (desde jul/2025) x-client, no formato "<user-id>-nome-da-ferramenta". Omitir o x-client faz o
// Habitica rejeitar a chamada. Este Worker monta os tres automaticamente a partir dos secrets.
//
// Como a API do Habitica e grande (User, Tasks, Tags, Group, Challenge, Content, Member,
// Inbox...) e alguns recursos tem corpo/formato proprio, o Worker mistura os dois estilos:
// ferramentas DEDICADAS para as acoes do dia a dia (ver tarefas, pontuar habito/tarefa) e
// ferramentas GENERICAS (api_get/api_post/api_put/api_delete) para o resto, no mesmo espirito
// do mcp-wger.

const HABITICA_API = 'https://habitica.com/api/v3';
const ISSUER = 'https://mcp-habitica.alexcordeiro.dev';
const AUTH_CODE_TTL = 60;              // segundos - codigo de autorizacao e de uso unico e rapido
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 dias

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
    description: 'Retorna o perfil e stats (HP, MP, XP, nivel, gold) do usuario Habitica autenticado pelo token configurado.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'listar_tarefas',
    description: 'Lista as tarefas do usuario (habits, dailies, todos ou rewards). Sem filtro, retorna tudo.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filtro opcional de tipo: "habits", "dailys", "todos", "rewards", ou "completedTodos" para to-dos ja concluidos.',
          enum: ['habits', 'dailys', 'todos', 'rewards', 'completedTodos']
        }
      }
    }
  },
  {
    name: 'pontuar_tarefa',
    description: 'Marca uma habit/daily/todo como feita (up) ou nao feita / habito negativo (down). Para todos e dailies normalmente so faz sentido "up"; para habits com os dois lados, "up" ou "down" conforme o botao clicado.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id da tarefa (uuid retornado por listar_tarefas)' },
        direction: { type: 'string', description: 'Direcao da pontuacao', enum: ['up', 'down'] }
      },
      required: ['id', 'direction']
    }
  },
  {
    name: 'api_get',
    description: 'Faz um GET generico num endpoint da API v3 do Habitica (ex: path="tags", path="content", path="group/party"). Use para qualquer recurso sem ferramenta dedicada.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do recurso, sem barras nas pontas. Ex: "tags", "challenges/user", "group/party"' },
        query: { type: 'object', description: 'Parametros de query string, ex: {"type": "public"}' }
      },
      required: ['path']
    }
  },
  {
    name: 'api_post',
    description: 'Cria um novo recurso na API v3 do Habitica (ex: criar tarefa, criar tag, entrar num desafio).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do recurso, sem barras nas pontas. Ex: "tasks/user", "tags"' },
        body: { type: 'object', description: 'Corpo JSON do novo registro, campos dependem do recurso' }
      },
      required: ['path', 'body']
    }
  },
  {
    name: 'api_put',
    description: 'Atualiza um recurso existente na API v3 do Habitica, dado o caminho completo (a API do Habitica usa PUT para update, nao PATCH). Ex: path="tasks/<id>" para editar uma tarefa.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho completo do recurso, incluindo id. Ex: "tasks/7d4a623d-...", "tags/abc123"' },
        body: { type: 'object', description: 'Campos a atualizar' }
      },
      required: ['path', 'body']
    }
  },
  {
    name: 'api_delete',
    description: 'Apaga um recurso existente na API v3 do Habitica, dado o caminho completo (ex: path="tasks/<id>").',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho completo do recurso, incluindo id. Ex: "tasks/7d4a623d-..."' }
      },
      required: ['path']
    }
  }
];

function buildUrl(path, query) {
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  const url = new URL(`${HABITICA_API}/${cleanPath}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function habitica(env, path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : buildUrl(path, opts.query), {
    method: opts.method || 'GET',
    headers: {
      'x-api-user': env.HABITICA_USER_ID,
      'x-api-key': env.HABITICA_API_TOKEN,
      'x-client': `${env.HABITICA_USER_ID}-mcp-habitica`,
      'Accept': 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || JSON.stringify(data))) || `Habitica API error ${res.status}`;
    throw new Error(`${res.status} ${msg}`);
  }
  // Habitica sempre embrulha em { success, data, ... } - devolvemos so o "data" util quando existe
  return (data && typeof data === 'object' && 'data' in data) ? data.data : data;
}

async function toolWhoami(env) {
  return habitica(env, 'user');
}
async function toolListarTarefas(env, args) {
  const { type } = args || {};
  return habitica(env, 'tasks/user', { method: 'GET', query: type ? { type } : undefined });
}
async function toolPontuarTarefa(env, args) {
  const { id, direction } = args;
  return habitica(env, `tasks/${id}/score/${direction}`, { method: 'POST' });
}
async function toolApiGet(env, args) {
  const { path, query } = args;
  return habitica(env, path, { method: 'GET', query });
}
async function toolApiPost(env, args) {
  const { path, body } = args;
  return habitica(env, path, { method: 'POST', body });
}
async function toolApiPut(env, args) {
  const { path, body } = args;
  return habitica(env, path, { method: 'PUT', body });
}
async function toolApiDelete(env, args) {
  const { path } = args;
  return habitica(env, path, { method: 'DELETE' });
}

async function callTool(env, name, args) {
  switch (name) {
    case 'whoami': return toolWhoami(env);
    case 'listar_tarefas': return toolListarTarefas(env, args);
    case 'pontuar_tarefa': return toolPontuarTarefa(env, args);
    case 'api_get': return toolApiGet(env, args);
    case 'api_post': return toolApiPost(env, args);
    case 'api_put': return toolApiPut(env, args);
    case 'api_delete': return toolApiDelete(env, args);
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
      serverInfo: { name: 'alexcordeiro-habitica-mcp', version: '1.0.0' }
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
  <h1>Autorizar acesso ao MCP Habitica</h1>
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
    await new Promise(r => setTimeout(r, 2000));
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
