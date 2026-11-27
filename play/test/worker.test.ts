// Testes de ponta a ponta do Worker: OAuth (registro, authorize com PKCE, token) e chamadas MCP.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker from '../src/worker.ts';
import { handleMcpMessage } from '../src/mcp.ts';

const ORIGIN = 'https://mcp-play.exemplo.dev';
const env = {
  MCP_SECRET: 'senha-de-teste-com-mais-de-32-caracteres',
  GOOGLE_SA_EMAIL: '',
  GOOGLE_SA_PRIVATE_KEY: '',
};
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function sha256b64url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Percorre o fluxo OAuth completo e devolve um access token.
async function accessToken(): Promise<string> {
  const reg = await worker.fetch(
    new Request(`${ORIGIN}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }),
    env as any,
  );
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = 'v'.repeat(64);
  const form = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: await sha256b64url(verifier),
    code_challenge_method: 'S256',
    response_type: 'code',
    key: env.MCP_SECRET,
  });
  const auth = await worker.fetch(
    new Request(`${ORIGIN}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }),
    env as any,
  );
  assert.equal(auth.status, 302);
  const code = new URL(auth.headers.get('Location')!).searchParams.get('code')!;
  const tok = await worker.fetch(
    new Request(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    }),
    env as any,
  );
  return ((await tok.json()) as { access_token: string }).access_token;
}

function rpc(token: string | null, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) }), env as any);
}

describe('worker', () => {
  it('/mcp sem Bearer devolve 401 com o metadata do recurso', async () => {
    const res = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('WWW-Authenticate')!, /oauth-protected-resource/);
  });

  it('fluxo OAuth completo libera initialize e tools/list', async () => {
    const token = await accessToken();
    const init = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(((await init.json()) as any).result.protocolVersion, '2025-06-18');
    const list = (await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any;
    assert.ok(list.result.tools.some((t: any) => t.name === 'responder_avaliacao'));
  });

  it('notificacao recebe 202 sem corpo e GET recebe 405', async () => {
    const token = await accessToken();
    const n = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(n.status, 202);
    const g = await worker.fetch(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } }), env as any);
    assert.equal(g.status, 405);
  });

  it('sem secrets do Google, a ferramenta diz o que falta sem expor valores', async () => {
    const token = await accessToken();
    const res = (await (await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listar_apps', arguments: {} } })).json()) as any;
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY/);
  });
});

describe('handleMcpMessage', () => {
  const cfg = { googleEmail: '', googleKey: '', missing: [] };

  it('recusa lote (array) e metodo desconhecido', async () => {
    assert.equal(((await handleMcpMessage([], cfg)) as any).error.code, -32600);
    assert.equal(((await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'x' }, cfg)) as any).error.code, -32601);
  });

  it('versao de protocolo desconhecida recebe a mais recente', async () => {
    const r = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, cfg)) as any;
    assert.equal(r.result.protocolVersion, '2025-06-18');
  });
});
