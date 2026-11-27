// MCP Worker do Google Play Console (mcp-play).
//
// Fluxo: claude.ai -> este Worker (OAuth 2.1 + PKCE) -> APIs do Google Play, autenticadas por uma
// conta de servico (JWT RS256 assinado com WebCrypto, access token em cache). O deploy dos apps
// fica fora daqui: este Worker nao publica versoes.
//
// Secrets (wrangler secret put <NOME> ou dashboard, tipo Secret):
//   MCP_SECRET             senha de aprovacao digitada na tela /authorize (minimo 32 caracteres)
//   JWT_SECRET             OPCIONAL. Chave HMAC que assina client_id, code, access e refresh token.
//                          Se nao existir, usa o MCP_SECRET.
//   GOOGLE_SA_EMAIL        client_email do JSON da conta de servico
//   GOOGLE_SA_PRIVATE_KEY  private_key do JSON da conta de servico (PEM PKCS#8)
//
// Rotas:
//   GET  /.well-known/oauth-authorization-server        metadata do servidor de autorizacao
//   GET  /.well-known/oauth-protected-resource[/mcp]    metadata do recurso
//   POST /register                                       registro dinamico de cliente (RFC 7591)
//   GET  /authorize                                      tela de aprovacao
//   POST /authorize                                      valida a senha e devolve o code
//   POST /token                                          code -> tokens, refresh_token -> tokens
//   POST /mcp                                            MCP (JSON-RPC 2.0), exige Bearer
//
// O OAuth e o mesmo do browser/: tudo stateless, client_id, code e tokens sao JWTs HS256.
// Para revogar tudo, troque o JWT_SECRET (ou o MCP_SECRET, se nao houver JWT_SECRET).
//
// Privacidade: o unico log e console.error com campos escolhidos a mao. Nunca entram tokens,
// secrets, headers, corpos de requisicao, avaliacoes nem dados de usuarios.

import { handleMcpMessage } from './mcp.ts';

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  MCP_SECRET: string;
  JWT_SECRET?: string;
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_PRIVATE_KEY: string;
  RATE_LIMITER?: RateLimit; // opcional: sem o binding, o rate limit e ignorado
}

type Claims = Record<string, any>;

// ---------- Configuracao ----------

const SCOPE = 'mcp';
const AUTH_CODE_TTL = 60;                       // segundos
const ACCESS_TOKEN_TTL = 60 * 60 * 24;          // 1 dia
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;    // 30 dias, renovado a cada uso
const REFRESH_MAX_AGE = 60 * 60 * 24 * 90;      // teto absoluto: reautoriza a cada 90 dias
const CLIENT_ID_TTL = 60 * 60 * 24 * 365 * 10;  // 10 anos
const MAX_BODY_BYTES = 1024 * 1024;             // 1 MiB por requisicao MCP
const MAX_FORM_BYTES = 8 * 1024;                // 8 KiB nos endpoints OAuth
const MIN_SECRET_LENGTH = 32;

// Callbacks OAuth aceitos (evita roubo de code por redirect_uri arbitrario).
const ALLOWED_REDIRECT_URIS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

// Valores aceitos no header Origin, quando ele vier.
const ALLOWED_ORIGINS = new Set(['https://claude.ai', 'https://www.claude.ai', 'https://claude.com']);

const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];

// ---------- Helpers de resposta ----------

function json(obj: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Log de erro com campos escolhidos a mao. Nunca passe token, secret, header ou corpo aqui.
function logError(event: string, fields: Record<string, string | number | null | undefined> = {}): void {
  console.error(JSON.stringify({ event, ...fields }));
}

// ---------- CORS ----------
// O claude.ai chama o Worker pelo servidor, que nao usa CORS. Mesmo assim respondemos o preflight
// e devolvemos Access-Control-Allow-Origin, mas so para as origens da allowlist (ex.: MCP Inspector
// ou o claude.ai no navegador). Qualquer outra origem nao recebe nenhum header CORS.

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version, WWW-Authenticate',
    Vary: 'Origin',
  };
}

function preflight(request: Request): Response {
  const origin = request.headers.get('Origin');
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) return text('Forbidden', 403);
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
      'Access-Control-Max-Age': '600',
    },
  });
}

// ---------- base64url + JWT HS256 (sem libs externas) ----------

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string) {
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

async function signJWT(payload: Claims, secret: string): Promise<string> {
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

// Confere assinatura, algoritmo, tipo (typ), emissor (iss) e validade (exp). Lanca erro se algo falhar.
async function verifyJWT(token: string, secret: string, typ: string, issuer: string): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [head, body, sig] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(head)));
  if (header.alg !== 'HS256') throw new Error('bad alg');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(`${head}.${body}`));
  if (!ok) throw new Error('bad signature');
  const payload: Claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (payload.typ !== typ || payload.iss !== issuer) throw new Error('wrong token');
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) throw new Error('expired');
  return payload;
}

async function sha256b64url(s: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

// Comparacao em tempo constante: compara os hashes SHA-256 (mesmo tamanho) byte a byte, sem sair cedo.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- Validacao de configuracao ----------

// Chave que assina os JWTs: JWT_SECRET, ou o MCP_SECRET quando nao ha JWT_SECRET.
function signingKey(env: Env): string {
  return env.JWT_SECRET || env.MCP_SECRET;
}

// Devolve so os NOMES dos secrets com problema (nunca os valores). Falha fechada: lista vazia = ok.
function authConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  if (typeof env.MCP_SECRET !== 'string' || env.MCP_SECRET.length < MIN_SECRET_LENGTH) problems.push('MCP_SECRET');
  if (env.JWT_SECRET && env.JWT_SECRET.length < MIN_SECRET_LENGTH) problems.push('JWT_SECRET');
  return problems;
}

// ---------- Rate limit ----------

// true = estourou o limite. Cada "bucket" tem contagem propria por IP. Sem o binding, nunca limita.
async function isLimited(env: Env, request: Request, bucket: string): Promise<boolean> {
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key: `${bucket}:${ip}` });
  return !success;
}

// ---------- Leitura de corpo com limite ----------

// Le o corpo em stream e aborta ao passar do limite (cobre corpos sem Content-Length). null = grande demais.
async function readBodyLimited(request: Request, max: number) {
  if (Number(request.headers.get('Content-Length') ?? '0') > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Le parametros OAuth de um corpo form-urlencoded ou JSON. So guarda valores string.
async function readParams(request: Request): Promise<Record<string, string>> {
  const bytes = await readBodyLimited(request, MAX_FORM_BYTES);
  if (bytes === null) throw new Error('too large');
  const raw = new TextDecoder().decode(bytes);
  const out: Record<string, string> = {};
  if ((request.headers.get('Content-Type') ?? '').includes('application/json')) {
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj ?? {})) if (typeof v === 'string') out[k] = v;
  } else {
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  }
  return out;
}

// ---------- OAuth: metadata ----------

function authServerMetadata(issuer: string): Response {
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: SUPPORTED_GRANTS,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  });
}

function resourceMetadata(issuer: string): Response {
  return json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'MCP Play Console',
  });
}

// RFC 8707: o parametro "resource" e opcional aqui. Se vier, precisa apontar para este recurso.
// Devolve o identificador canonico do recurso, ou null se o valor for de outro servidor.
function canonicalResource(issuer: string, raw: string | null | undefined): string | null {
  if (!raw) return `${issuer}/mcp`;
  const r = raw.replace(/\/+$/, '');
  return r === `${issuer}/mcp` || r === issuer ? `${issuer}/mcp` : null;
}

// ---------- OAuth: registro dinamico de cliente (RFC 7591) ----------
// O client_id e um JWT assinado que carrega os redirect_uris registrados. Nada e gravado em banco.

async function handleRegister(request: Request, env: Env, issuer: string): Promise<Response> {
  const problems = authConfigProblems(env);
  if (problems.length) {
    logError('config_invalid', { where: 'register', secrets: problems.join(',') });
    return json({ error: 'server_error' }, 500);
  }
  if (await isLimited(env, request, 'oauth')) return json({ error: 'too_many_requests' }, 429, { 'Retry-After': '60' });

  let meta: Claims;
  try {
    meta = JSON.parse(new TextDecoder().decode((await readBodyLimited(request, MAX_FORM_BYTES)) ?? new Uint8Array()));
  } catch {
    return json({ error: 'invalid_client_metadata', error_description: 'corpo JSON invalido' }, 400);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return json({ error: 'invalid_client_metadata', error_description: 'corpo JSON invalido' }, 400);
  }

  // redirect_uris: lista de 1 a 5 itens, todos na allowlist (comparacao exata).
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === 'string' && ALLOWED_REDIRECT_URIS.has(u))) {
    return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris fora da allowlist' }, 400);
  }
  // Cliente publico: so aceitamos auth method "none", grants e response types suportados.
  if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== 'none') {
    return json({ error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method deve ser none' }, 400);
  }
  if (meta.grant_types !== undefined && !(Array.isArray(meta.grant_types) && meta.grant_types.every((g: unknown) => typeof g === 'string' && SUPPORTED_GRANTS.includes(g)))) {
    return json({ error: 'invalid_client_metadata', error_description: 'grant_types nao suportado' }, 400);
  }
  if (meta.response_types !== undefined && !(Array.isArray(meta.response_types) && meta.response_types.every((t: unknown) => t === 'code'))) {
    return json({ error: 'invalid_client_metadata', error_description: 'response_types deve ser code' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const clientId = await signJWT({ typ: 'client', iss: issuer, redirect_uris: uris, iat: now, exp: now + CLIENT_ID_TTL }, signingKey(env));
  const clientName = typeof meta.client_name === 'string' ? meta.client_name.slice(0, 100) : 'MCP client';

  return json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      client_name: clientName,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: meta.grant_types ?? ['authorization_code'],
      response_types: ['code'],
      scope: SCOPE,
    },
    201,
  );
}

// ---------- OAuth: /authorize ----------

function approvePage(fields: Record<string, string>, error?: string, status = 200): Response {
  // O segredo vai por POST (corpo), nunca na URL.
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n    ');
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const page = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar acesso</title>
<style nonce="${nonce}">
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 16px; margin: 12px 0; box-sizing: border-box; }
  button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
  .err { color: #b00020; }
</style></head>
<body>
  <h1>Autorizar acesso ao MCP Play Console</h1>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    ${hidden}
    <input type="password" name="key" placeholder="Senha de aprovacao" autocomplete="off" autofocus required>
    <button type="submit">Aprovar</button>
  </form>
</body></html>`;
  return new Response(page, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      // Sem script e sem inline: o style usa nonce. form-action lista o destino do redirect pos-POST
      // (o navegador valida o redirect). frame-ancestors impede clickjacking.
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' https://claude.ai https://claude.com; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

type AuthParams = { ok: true; params: Record<string, string> } | { ok: false; message: string };

// Valida os parametros OAuth comuns ao GET e ao POST de /authorize.
async function readAuthParams(get: (k: string) => string | null, env: Env, issuer: string): Promise<AuthParams> {
  const client_id = get('client_id') ?? '';
  const redirect_uri = get('redirect_uri') ?? '';
  const code_challenge = get('code_challenge') ?? '';
  const method = get('code_challenge_method') ?? 'S256';
  const response_type = get('response_type') ?? 'code';
  const state = get('state') ?? '';

  // 1. O client_id precisa ser um JWT emitido por /register e o redirect_uri precisa estar nele.
  let client: Claims;
  try {
    client = await verifyJWT(client_id, signingKey(env), 'client', issuer);
  } catch {
    return { ok: false, message: 'invalid_client' };
  }
  if (!ALLOWED_REDIRECT_URIS.has(redirect_uri) || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirect_uri)) {
    return { ok: false, message: 'invalid redirect_uri' };
  }
  // 2. PKCE S256 obrigatorio. O challenge e um SHA-256 em base64url (43 caracteres).
  if (response_type !== 'code' || method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge)) {
    return { ok: false, message: 'invalid_request' };
  }
  // 3. RFC 8707: se o cliente mandou resource, ele precisa ser este servidor.
  const resource = canonicalResource(issuer, get('resource'));
  if (!resource) return { ok: false, message: 'invalid_target' };
  if (state.length > 512) return { ok: false, message: 'invalid_request' };

  return { ok: true, params: { client_id, redirect_uri, state, code_challenge, code_challenge_method: 'S256', response_type: 'code', resource } };
}

async function handleAuthorize(request: Request, env: Env, issuer: string): Promise<Response> {
  const problems = authConfigProblems(env);
  if (problems.length) {
    logError('config_invalid', { where: 'authorize', secrets: problems.join(',') });
    return text('Server misconfigured', 500);
  }
  if (await isLimited(env, request, 'oauth')) return text('Too many requests', 429);

  if (request.method === 'GET') {
    const sp = new URL(request.url).searchParams;
    const r = await readAuthParams((k) => sp.get(k), env, issuer);
    return r.ok ? approvePage(r.params) : text(r.message, 400);
  }

  let form: Record<string, string>;
  try {
    form = await readParams(request);
  } catch {
    return text('Invalid request', 400);
  }
  const r = await readAuthParams((k) => form[k] ?? null, env, issuer);
  if (!r.ok) return text(r.message, 400);

  if (typeof form.key !== 'string' || !(await safeEqual(form.key, env.MCP_SECRET))) {
    await new Promise((res) => setTimeout(res, 2000)); // freia tentativa de forca bruta (tempo de relogio, sem CPU)
    return approvePage(r.params, 'Senha incorreta.', 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const code = await signJWT(
    { typ: 'auth_code', iss: issuer, cid: r.params.client_id, redirect_uri: r.params.redirect_uri, code_challenge: r.params.code_challenge, iat: now, exp: now + AUTH_CODE_TTL },
    signingKey(env),
  );
  const redirect = new URL(r.params.redirect_uri);
  redirect.searchParams.set('code', code);
  if (r.params.state) redirect.searchParams.set('state', r.params.state);
  return new Response(null, { status: 302, headers: { Location: redirect.toString(), 'Cache-Control': 'no-store' } });
}

// ---------- OAuth: /token ----------

function oauthError(error: string, description?: string, status = 400): Response {
  return json(description ? { error, error_description: description } : { error }, status);
}

// Emite access token (1 dia) e refresh token (30 dias, com teto de 90 dias desde a aprovacao).
async function issueTokens(env: Env, issuer: string, clientId: string, authTime: number): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const aud = `${issuer}/mcp`;
  const key = signingKey(env);
  const access = await signJWT({ typ: 'access_token', iss: issuer, aud, sub: 'owner', cid: clientId, iat: now, exp: now + ACCESS_TOKEN_TTL }, key);
  const refresh = await signJWT(
    { typ: 'refresh_token', iss: issuer, aud, cid: clientId, auth_time: authTime, iat: now, exp: Math.min(now + REFRESH_TOKEN_TTL, authTime + REFRESH_MAX_AGE) },
    key,
  );
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL, refresh_token: refresh, scope: SCOPE });
}

async function handleToken(request: Request, env: Env, issuer: string): Promise<Response> {
  const problems = authConfigProblems(env);
  if (problems.length) {
    logError('config_invalid', { where: 'token', secrets: problems.join(',') });
    return oauthError('server_error', undefined, 500);
  }
  if (await isLimited(env, request, 'oauth')) return oauthError('slow_down', undefined, 429);

  let p: Record<string, string>;
  try {
    p = await readParams(request);
  } catch {
    return oauthError('invalid_request');
  }
  if (!canonicalResource(issuer, p.resource)) return oauthError('invalid_target');

  const key = signingKey(env);
  const now = Math.floor(Date.now() / 1000);

  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.redirect_uri || !p.code_verifier) return oauthError('invalid_request');
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(p.code_verifier)) return oauthError('invalid_grant');
    let code: Claims;
    try {
      code = await verifyJWT(p.code, key, 'auth_code', issuer);
    } catch {
      return oauthError('invalid_grant');
    }
    // redirect_uri e client_id precisam ser os mesmos do /authorize, e o PKCE precisa fechar.
    if (code.redirect_uri !== p.redirect_uri || (p.client_id && p.client_id !== code.cid)) return oauthError('invalid_grant');
    if (!(await safeEqual(await sha256b64url(p.code_verifier), code.code_challenge))) return oauthError('invalid_grant', 'PKCE nao confere');
    return issueTokens(env, issuer, code.cid, now);
  }

  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return oauthError('invalid_request');
    let refresh: Claims;
    try {
      refresh = await verifyJWT(p.refresh_token, key, 'refresh_token', issuer);
    } catch {
      return oauthError('invalid_grant');
    }
    if (p.client_id && p.client_id !== refresh.cid) return oauthError('invalid_grant');
    if (typeof refresh.auth_time !== 'number' || now > refresh.auth_time + REFRESH_MAX_AGE) return oauthError('invalid_grant');
    return issueTokens(env, issuer, refresh.cid, refresh.auth_time);
  }

  return oauthError('unsupported_grant_type');
}

// ---------- Autenticacao do /mcp ----------

// 'ok' = Bearer valido para este recurso; 'missing' = sem header Bearer; 'invalid' = token ruim.
async function bearerState(request: Request, env: Env, issuer: string): Promise<'ok' | 'missing' | 'invalid'> {
  const match = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!match) return 'missing';
  try {
    const payload = await verifyJWT(match[1], signingKey(env), 'access_token', issuer);
    return payload.aud === `${issuer}/mcp` ? 'ok' : 'invalid'; // RFC 8707: token so vale para este recurso
  } catch {
    return 'invalid';
  }
}
// Nomes dos secrets do Google que faltam (nunca os valores).
function googleConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  if (!env.GOOGLE_SA_EMAIL) problems.push('GOOGLE_SA_EMAIL');
  if (!env.GOOGLE_SA_PRIVATE_KEY) problems.push('GOOGLE_SA_PRIVATE_KEY');
  return problems;
}

async function handleMcp(request: Request, env: Env, issuer: string): Promise<Response> {
  // 1. Origin do navegador, quando presente, precisa estar na allowlist.
  const origin = request.headers.get('Origin');
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) return text('Forbidden', 403);

  // 2. Configuracao de autenticacao valida (so os nomes vao para o log).
  const authProblems = authConfigProblems(env);
  if (authProblems.length) {
    logError('config_invalid', { where: 'mcp', secrets: authProblems.join(',') });
    return text('Server misconfigured', 500);
  }

  // 3. Autenticacao do chamador (OAuth Bearer). RFC 6750: sem token, o desafio nao leva "error".
  const state = await bearerState(request, env, issuer);
  if (state !== 'ok') {
    if (await isLimited(env, request, 'mcp-auth')) return text('Too many requests', 429);
    const challenge = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;
    return json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': state === 'invalid' ? `${challenge}, error="invalid_token"` : challenge });
  }

  // 4. So POST: este servidor nao abre stream SSE (GET) nem guarda sessao (DELETE).
  if (request.method !== 'POST') return text('Method not allowed', 405, { Allow: 'POST' });

  // 5. Corpo JSON-RPC com limite de tamanho.
  const bytes = await readBodyLimited(request, MAX_BODY_BYTES);
  if (bytes === null) return text('Payload too large', 413);
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const reply = await handleMcpMessage(message, { googleEmail: env.GOOGLE_SA_EMAIL, googleKey: env.GOOGLE_SA_PRIVATE_KEY, missing: googleConfigProblems(env) });
  // Notificacoes nao tem resposta: 202 sem corpo.
  if (reply === null) return new Response(null, { status: 202 });
  return json(reply);
}

// ---------- Router ----------

async function route(request: Request, env: Env, issuer: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  const m = request.method;

  if (m === 'GET' && pathname === '/.well-known/oauth-authorization-server') return authServerMetadata(issuer);
  // RFC 9728: o cliente pode buscar o metadata com ou sem o caminho do recurso (/mcp).
  if (m === 'GET' && (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp')) {
    return resourceMetadata(issuer);
  }
  if (pathname === '/register' && m === 'POST') return handleRegister(request, env, issuer);
  if (pathname === '/authorize' && (m === 'GET' || m === 'POST')) return handleAuthorize(request, env, issuer);
  if (pathname === '/token' && m === 'POST') return handleToken(request, env, issuer);
  if (pathname === '/mcp') return handleMcp(request, env, issuer);
  return text('Not found', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const issuer = new URL(request.url).origin; // sem dominio fixo no codigo

    if (request.method === 'OPTIONS') return preflight(request);

    const res = await route(request, env, issuer);

    // Acrescenta CORS so para origens da allowlist (copia a resposta porque os headers podem ser imutaveis).
    const cors = corsHeaders(request);
    if (Object.keys(cors).length === 0) return res;
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) copy.headers.set(k, v);
    return copy;
  },
};
