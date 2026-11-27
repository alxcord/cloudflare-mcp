// Testes da montagem das chamadas as APIs do Google e da conversao de erros.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildUrl, GoogleApiError, PlayApi, PUBLISHER_BASE, REPORTING_BASE, requests } from '../src/play-api.ts';
import { MockGoogle } from './helpers.ts';

const PKG = 'com.exemplo.app';
const BASE = `${PUBLISHER_BASE}/applications/${PKG}`;

describe('buildUrl', () => {
  it('codifica cada segmento e ignora query indefinida', () => {
    assert.equal(buildUrl('https://x', ['a b', 'c/d'], ':go', { q: 'x y', z: undefined }), 'https://x/a%20b/c%2Fd:go?q=x+y');
  });
});

describe('requests', () => {
  it('listagem de apps na Reporting API', () => {
    assert.equal(requests.searchApps().url, `${REPORTING_BASE}/apps:search?pageSize=1000`);
  });

  it('avaliacoes: listar, ler e responder', () => {
    assert.equal(requests.listReviews(PKG, { maxResults: 20, translationLanguage: 'pt' }).url, `${BASE}/reviews?maxResults=20&translationLanguage=pt`);
    assert.equal(requests.getReview(PKG, 'gp:abc').url, `${BASE}/reviews/gp%3Aabc`);
    const reply = requests.replyReview(PKG, 'gp:abc', 'Obrigado');
    assert.equal(reply.method, 'POST');
    assert.equal(reply.url, `${BASE}/reviews/gp%3Aabc:reply`);
    assert.deepEqual(reply.body, { replyText: 'Obrigado' });
  });

  it('edits: commit nao cancela revisao em andamento', () => {
    assert.equal(requests.insertEdit(PKG).url, `${BASE}/edits`);
    assert.equal(requests.commitEdit(PKG, 'e1').url, `${BASE}/edits/e1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`);
    assert.equal(requests.deleteEdit(PKG, 'e1').method, 'DELETE');
    assert.equal(requests.listTracks(PKG, 'e1').url, `${BASE}/edits/e1/tracks`);
  });

  it('testadores: PUT com a lista inteira de grupos', () => {
    const r = requests.updateTesters(PKG, 'e1', 'Closed testing', ['g@googlegroups.com']);
    assert.equal(r.method, 'PUT');
    assert.equal(r.url, `${BASE}/edits/e1/testers/Closed%20testing`);
    assert.deepEqual(r.body, { googleGroups: ['g@googlegroups.com'] });
  });

  it('produtos: caminhos de produto unico e assinatura', () => {
    assert.equal(requests.listProducts(PKG, 'unico').url, `${BASE}/oneTimeProducts?pageSize=100`);
    assert.equal(requests.getProduct(PKG, 'assinatura', 'premium').url, `${BASE}/subscriptions/premium`);
    const patch = requests.patchProduct(PKG, 'unico', 'moedas', { x: 1 }, { updateMask: 'listings', regionsVersion: '2022/02' });
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.url, `${BASE}/onetimeproducts/moedas?updateMask=listings&regionsVersion.version=2022%2F02&allowMissing=true`);
  });

  it('produtos: ativar e desativar opcao ou plano base', () => {
    const sub = requests.setOptionState(PKG, 'assinatura', 'premium', 'mensal', 'desativar');
    assert.equal(sub.url, `${BASE}/subscriptions/premium/basePlans/mensal:deactivate`);
    const one = requests.setOptionState(PKG, 'unico', 'moedas', 'compra', 'ativar');
    assert.equal(one.url, `${BASE}/oneTimeProducts/moedas/purchaseOptions:batchUpdateStates`);
    assert.deepEqual(one.body, { requests: [{ activatePurchaseOptionRequest: { packageName: PKG, productId: 'moedas', purchaseOptionId: 'compra' } }] });
  });

  it('seguranca dos dados', () => {
    const r = requests.dataSafety(PKG, 'a,b\n1,2');
    assert.equal(r.url, `${BASE}/dataSafety`);
    assert.deepEqual(r.body, { safetyLabels: 'a,b\n1,2' });
  });
});

describe('PlayApi.call', () => {
  it('envia o Bearer e o JSON', async () => {
    const google = new MockGoogle().on('POST', /:reply$/, { body: { result: { replyText: 'ok' } } });
    const api = new PlayApi(async () => 'token-teste', google.fetch);
    const out = await api.call(requests.replyReview(PKG, 'r1', 'ok'));
    assert.deepEqual(out, { result: { replyText: 'ok' } });
    assert.equal(google.calls[0].headers.authorization, 'Bearer token-teste');
    assert.equal(google.calls[0].headers['content-type'], 'application/json');
  });

  it('converte erro do Google sem incluir o token', async () => {
    const google = new MockGoogle().on('GET', /reviews/, { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } });
    const api = new PlayApi(async () => 'token-secreto', google.fetch);
    await assert.rejects(
      () => api.call(requests.getReview(PKG, 'r1')),
      (e: unknown) => {
        assert.ok(e instanceof GoogleApiError);
        assert.equal(e.status, 403);
        assert.equal(e.googleStatus, 'PERMISSION_DENIED');
        assert.doesNotMatch(e.message, /token-secreto/);
        return true;
      },
    );
  });

  it('resposta vazia (ex.: DELETE do edit) vira objeto vazio', async () => {
    const google = new MockGoogle().on('DELETE', /edits\/e1$/, { status: 204 });
    const api = new PlayApi(async () => 't', google.fetch);
    assert.deepEqual(await api.call(requests.deleteEdit(PKG, 'e1')), {});
  });
});
