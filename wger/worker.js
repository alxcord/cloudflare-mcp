// MCP Worker - leitura e escrita real na API do Wger (wger.de) via Cloudflare Workers
// Arquivo unico, sem build/npm.
//
// Secrets necessarios (aba Settings > Variables and Secrets do Worker):
//   WGER_TOKEN  - Permanent Token da API do Wger (gerado nas configuracoes do usuario, secao "API key")
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
// Diferente do mcp-git (que tem ferramentas dedicadas por operacao), este Worker expoe um
// pequeno conjunto de ferramentas GENERICAS que conversam com qualquer endpoint da API v2 do
// Wger (https://wger.de/api/v2/<recurso>/). Isso evita fixar no codigo suposicoes sobre nomes
// exatos de campos de cada recurso (peso, rotina, nutricao, etc.) que podem mudar entre versoes
// da API - quem decide o endpoint e o corpo da chamada e o Claude, olhando a documentacao/schema
// da API quando precisar.

const WGER_API = 'https://wger.de/api/v2';
const ISSUER = 'https://mcp-wger.alexcordeiro.dev';
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

// ---------- Tools (identico ao worker anterior) ----------

const TOOLS = [
  {
    name: 'whoami',
    description: 'Retorna o perfil do usuario do Wger autenticado pelo token configurado.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'api_get',
    description: 'Faz um GET generico num endpoint da API v2 do Wger (ex: path="weightentry", path="routine", path="exercise/search"). Use para listar ou consultar qualquer recurso.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do recurso, sem barras nas pontas. Ex: "weightentry", "routine/123", "exercise/search"' },
        query: { type: 'object', description: 'Parametros de query string, ex: {"limit": "10", "term": "supino"}' }
      },
      required: ['path']
    }
  },
  {
    name: 'api_post',
    description: 'Cria um novo registro num endpoint da API v2 do Wger (ex: registrar peso, criar sessao de treino, criar entrada no diario nutricional).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do recurso, sem barras nas pontas. Ex: "weightentry", "nutritiondiary"' },
        body: { type: 'object', description: 'Corpo JSON do novo registro, campos dependem do recurso' }
      },
      required: ['path', 'body']
    }
  },
  {
    name: 'api_patch',
    description: 'Atualiza parcialmente um registro existente na API v2 do Wger, dado o id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Nome do recurso, sem id. Ex: "weightentry"' },
        id: { type: 'string', description: 'Id do registro a atualizar' },
        body: { type: 'object', description: 'Campos a atualizar' }
      },
      required: ['path', 'id', 'body']
    }
  },
  {
    name: 'api_delete',
    description: 'Apaga um registro existente na API v2 do Wger, dado o id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Nome do recurso, sem id. Ex: "weightentry"' },
        id: { type: 'string', description: 'Id do registro a apagar' }
      },
      required: ['path', 'id']
    }
  }
];

function buildUrl(path, query) {
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  const url = new URL(`${WGER_API}/${cleanPath}/`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function wger(env, path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : buildUrl(path, opts.query), {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Token ${env.WGER_TOKEN}`,
      'Accept': 'application/json',
      'User-Agent': 'alexcordeiro-mcp-worker',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail || JSON.stringify(data))) || `Wger API error ${res.status}`;
    throw new Error(`${res.status} ${msg}`);
  }
  return data;
}

async function toolWhoami(env) {
  return wger(env, 'userprofile');
}
async function toolApiGet(env, args) {
  const { path, query } = args;
  return wger(env, path, { method: 'GET', query });
}
async function toolApiPost(env, args) {
  const { path, body } = args;
  return wger(env, path, { method: 'POST', body });
}
async function toolApiPatch(env, args) {
  const { path, id, body } = args;
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  return wger(env, `${cleanPath}/${id}`, { method: 'PATCH', body });
}
async function toolApiDelete(env, args) {
  const { path, id } = args;
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  return wger(env, `${cleanPath}/${id}`, { method: 'DELETE' });
}

async function callTool(env, name, args) {
  switch (name) {
    case 'whoami': return toolWhoami(env);
    case 'api_get': return toolApiGet(env, args);
    case 'api_post': return toolApiPost(env, args);
    case 'api_patch': return toolApiPatch(env, args);
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
      serverInfo: { name: 'alexcordeiro-wger-mcp', version: '2.0.0' }
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
  <h1>Autorizar acesso ao MCP Wger</h1>
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
