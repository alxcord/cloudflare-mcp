// MCP Worker - proxy seguro na frente do Playwright MCP (atras do Cloudflare Access).
//
// Fluxo: claude.ai -> este Worker (OAuth 2.1 + PKCE) -> origin protegido por Access
// (o Worker injeta o Service Token). O claude.ai nao envia headers customizados,
// por isso o Service Token fica aqui e nunca sai do Worker.
//
// Secrets (wrangler secret put <NOME>):
//   MCP_SECRET               senha de aprovacao na tela /authorize e chave HMAC dos tokens OAuth
//   CF_ACCESS_CLIENT_ID      Client ID do Service Token "claude-browser"
//   CF_ACCESS_CLIENT_SECRET  Client Secret do Service Token "claude-browser"
// Var (wrangler.jsonc): ORIGIN_URL, URL completa do Playwright MCP atras do Access.
//
// Rotas:
//   GET  /.well-known/oauth-authorization-server   metadata OAuth
//   GET  /.well-known/oauth-protected-resource     metadata do recurso
//   GET  /authorize                                tela de aprovacao
//   POST /authorize                                valida o segredo e devolve o code
//   POST /token                                    troca code por access_token
//   GET|POST|DELETE /mcp                           proxy autenticado (Bearer)
//
// Privacidade: este arquivo nunca chama console.log. Nenhum header, corpo ou secret e logado.

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  MCP_SECRET: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  ORIGIN_URL: string;
  RATE_LIMITER?: RateLimit; // opcional: sem o binding, o rate limit e ignorado
}

// ---------- Configuracao ----------

const AUTH_CODE_TTL = 60;                    // segundos
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 7;   // 7 dias
const MAX_BODY_BYTES = 1024 * 1024;          // 1 MiB por requisicao

// Callbacks OAuth aceitos (evita roubo de code por redirect_uri arbitrario).
const ALLOWED_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

// Valores aceitos no header Origin, quando ele vier.
const ALLOWED_ORIGINS = new Set(['https://claude.ai', 'https://www.claude.ai', 'https://claude.com']);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);

// Unicos headers do cliente repassados ao origin. Todo o resto e descartado.
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];

// Unicos headers do origin repassados ao cliente.
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version'];

// ---------- Helpers de resposta ----------

function json(obj: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- base64url + JWT HS256 (sem libs externas) ----------

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const enc = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, any>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [head, body, sig] = parts;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(`${head}.${body}`));
  if (!ok) throw new Error('bad signature');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) throw new Error('expired');
  return payload;
}

async function sha256b64url(s: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

// Comparacao em tempo constante: compara os hashes SHA-256 (mesmo tamanho) com timingSafeEqual.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return (crypto.subtle as any).timingSafeEqual(ha, hb);
}

// Falha fechada: sem um MCP_SECRET forte, os endpoints de autenticacao nao funcionam.
function secretOk(env: Env): boolean {
  return typeof env.MCP_SECRET === 'string' && env.MCP_SECRET.length >= 32;
}

// ---------- OAuth ----------

function metadata(issuer: string): Response {
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

function approvePage(fields: Record<string, string>, error?: string, status = 200): Response {
  // O segredo vai por POST (corpo), nunca na URL.
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n    ');
  const page = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar acesso</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 16px; margin: 12px 0; box-sizing: border-box; }
  button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
  .err { color: #b00020; }
</style></head>
<body>
  <h1>Autorizar acesso ao MCP Browser</h1>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    ${hidden}
    <input type="password" name="key" placeholder="MCP_SECRET" autocomplete="off" autofocus required>
    <button type="submit">Aprovar</button>
  </form>
</body></html>`;
  return new Response(page, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // form-action lista o destino do redirect pos-POST (o navegador valida o redirect).
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com; frame-ancestors 'none'",
    },
  });
}

// Valida os parametros OAuth comuns ao GET e ao POST de /authorize.
function readAuthParams(get: (k: string) => string | null): Record<string, string> | null {
  const redirect_uri = get('redirect_uri') ?? '';
  const code_challenge = get('code_challenge') ?? '';
  const method = get('code_challenge_method') ?? 'S256';
  const response_type = get('response_type') ?? 'code';
  if (!ALLOWED_REDIRECT_URIS.has(redirect_uri) || !code_challenge || method !== 'S256' || response_type !== 'code') return null;
  return {
    client_id: get('client_id') ?? '',
    redirect_uri,
    state: get('state') ?? '',
    code_challenge,
    code_challenge_method: 'S256',
    response_type: 'code',
  };
}

async function handleAuthorize(request: Request, env: Env, issuer: string): Promise<Response> {
  if (!secretOk(env)) return text('Server misconfigured', 500);

  if (request.method === 'GET') {
    const params = readAuthParams((k) => new URL(request.url).searchParams.get(k));
    return params ? approvePage(params) : text('Invalid OAuth request', 400);
  }

  const form = await request.formData();
  const params = readAuthParams((k) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : null;
  });
  if (!params) return text('Invalid OAuth request', 400);

  const key = form.get('key');
  if (typeof key !== 'string' || !(await safeEqual(key, env.MCP_SECRET))) {
    await new Promise((r) => setTimeout(r, 2000)); // freia tentativa de forca bruta
    return approvePage(params, 'Segredo incorreto.', 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const code = await signJWT(
    { iss: issuer, aud: params.client_id, typ: 'auth_code', redirect_uri: params.redirect_uri, code_challenge: params.code_challenge, iat: now, exp: now + AUTH_CODE_TTL },
    env.MCP_SECRET,
  );
  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', params.state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleToken(request: Request, env: Env, issuer: string): Promise<Response> {
  if (!secretOk(env)) return text('Server misconfigured', 500);

  const form = await request.formData().catch(() => null);
  const get = (k: string) => {
    const v = form?.get(k);
    return typeof v === 'string' ? v : '';
  };
  if (get('grant_type') !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);

  const code = get('code');
  const redirectUri = get('redirect_uri');
  const verifier = get('code_verifier');
  if (!code || !redirectUri || !verifier) return json({ error: 'invalid_request' }, 400);

  let payload: Record<string, any>;
  try {
    payload = await verifyJWT(code, env.MCP_SECRET);
  } catch {
    return json({ error: 'invalid_grant' }, 400);
  }
  // PKCE: o hash do verifier precisa bater com o challenge gravado no code.
  if (payload.typ !== 'auth_code' || payload.redirect_uri !== redirectUri || (await sha256b64url(verifier)) !== payload.code_challenge) {
    return json({ error: 'invalid_grant' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signJWT(
    { iss: issuer, aud: payload.aud, sub: 'owner', typ: 'access_token', iat: now, exp: now + ACCESS_TOKEN_TTL },
    env.MCP_SECRET,
  );
  return json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL });
}

async function hasValidBearer(request: Request, env: Env): Promise<boolean> {
  if (!secretOk(env)) return false;
  const match = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  try {
    const payload = await verifyJWT(match[1], env.MCP_SECRET);
    return payload.typ === 'access_token';
  } catch {
    return false;
  }
}

// ---------- Proxy ----------

// Conta os bytes que passam e aborta ao exceder o limite (cobre corpos sem Content-Length).
function limitBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('body too large'));
        else controller.enqueue(chunk);
      },
    }),
  );
}

async function proxyMcp(request: Request, env: Env, issuer: string): Promise<Response> {
  // 1. Origin do navegador, quando presente, precisa estar na allowlist.
  const origin = request.headers.get('Origin');
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) return text('Forbidden', 403);

  // 2. Autenticacao do chamador (OAuth Bearer).
  if (!(await hasValidBearer(request, env))) {
    return json({ error: 'invalid_token' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    });
  }

  // 3. Tamanho do corpo pelo Content-Length (quando informado).
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return text('Payload too large', 413);

  // 4. Reconstroi os headers do zero: allowlist + Service Token. Nada do cliente alem da lista.
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
  headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);

  // 5. Chama o origin repassando o corpo como stream, sem ler nem guardar.
  let upstream: Response;
  try {
    upstream = await fetch(env.ORIGIN_URL, {
      method: request.method,
      headers,
      body: request.method === 'POST' && request.body ? limitBody(request.body, MAX_BODY_BYTES) : undefined,
      redirect: 'manual', // redirect do Access (login) nao deve ser seguido nem exposto
    });
  } catch {
    return text('Bad gateway', 502);
  }

  // Falhas do Access (3xx/401/403) e erros 5xx do origin viram 502 generico.
  if (upstream.status >= 500 || (upstream.status >= 300 && upstream.status < 400) || upstream.status === 401 || upstream.status === 403) {
    return text('Bad gateway', 502);
  }

  // 6. Devolve so os headers da allowlist e o corpo em stream (preserva SSE).
  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set('X-Content-Type-Options', 'nosniff');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ---------- Router ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const issuer = url.origin; // sem dominio fixo no codigo
    const { pathname } = url;

    // Rate limit por IP (opcional, via binding).
    if (env.RATE_LIMITER) {
      const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) return text('Too many requests', 429);
    }

    if (pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') return metadata(issuer);
    if (pathname === '/.well-known/oauth-protected-resource' && request.method === 'GET') {
      return json({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });
    }
    if (pathname === '/authorize' && (request.method === 'GET' || request.method === 'POST')) return handleAuthorize(request, env, issuer);
    if (pathname === '/token' && request.method === 'POST') return handleToken(request, env, issuer);

    if (pathname === '/mcp') {
      if (!ALLOWED_METHODS.has(request.method)) return text('Method not allowed', 405);
      return proxyMcp(request, env, issuer);
    }

    return text('Not found', 404);
  },
};
