// Testes das ferramentas com a API do Google mockada: confirmacao, edits, validacao e erros.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { PlayApi } from '../src/play-api.ts';
import { callTool, resetAppsCache } from '../src/tools.ts';
import { MockGoogle } from './helpers.ts';

const PKG = 'com.exemplo.app';

// Mock com a listagem de apps e o ciclo de edits ja configurados.
function google(): MockGoogle {
  return new MockGoogle()
    .on('GET', /apps:search/, { body: { apps: [{ packageName: PKG, displayName: 'Exemplo' }] } })
    .on('POST', /\/edits$/, { body: { id: 'edit1' } })
    .on('DELETE', /\/edits\/edit1$/, { status: 204 });
}

async function run(g: MockGoogle, name: string, args: Record<string, unknown>, extraPackages?: string[]) {
  const res = await callTool({ api: new PlayApi(async () => 'token-teste', g.fetch), extraPackages }, name, args);
  const text = res.content[0].text;
  return { isError: Boolean(res.isError), text, data: res.isError ? undefined : JSON.parse(text) };
}

const methods = (g: MockGoogle) => g.apiCalls().map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '').split('?')[0]}`);

beforeEach(() => resetAppsCache());

describe('apps e package name', () => {
  it('listar_apps devolve nome e package name', async () => {
    const { data } = await run(google(), 'listar_apps', {});
    assert.deepEqual(data, { total: 1, apps: [{ nome: 'Exemplo', package_name: PKG, origem: 'play_console' }] });
  });

  it('soma os apps do PLAY_PACKAGES sem duplicar', async () => {
    const { data } = await run(google(), 'listar_apps', {}, [PKG, 'com.extra.app']);
    assert.deepEqual(data.apps, [
      { nome: 'Exemplo', package_name: PKG, origem: 'play_console' },
      { nome: '', package_name: 'com.extra.app', origem: 'PLAY_PACKAGES' },
    ]);
  });

  it('com apps:search vazio, aceita o app do PLAY_PACKAGES', async () => {
    const g = new MockGoogle()
      .on('GET', /apps:search/, { body: {} })
      .on('GET', /\/reviews\?/, { body: { reviews: [] } });
    const r = await run(g, 'listar_avaliacoes', { package_name: 'com.extra.app' }, ['com.extra.app']);
    assert.equal(r.isError, false);
  });

  it('com apps:search falhando, segue so com o PLAY_PACKAGES', async () => {
    const g = new MockGoogle().on('GET', /apps:search/, { status: 403, body: { error: { message: 'denied' } } });
    const { data } = await run(g, 'listar_apps', {}, ['com.extra.app']);
    assert.deepEqual(data.apps, [{ nome: '', package_name: 'com.extra.app', origem: 'PLAY_PACKAGES' }]);
    const semExtras = await run(g, 'listar_apps', {});
    assert.equal(semExtras.isError, true);
  });

  it('recusa app fora da conta sem chamar a API do app', async () => {
    const g = google();
    const r = await run(g, 'listar_avaliacoes', { package_name: 'com.outro.app' });
    assert.equal(r.isError, true);
    assert.match(r.text, /nao aparece entre os apps/);
    assert.ok(methods(g).every((m) => m.includes('apps:search')));
  });

  it('recusa package name com caractere de URL antes de qualquer chamada', async () => {
    const g = google();
    const r = await run(g, 'ler_avaliacao', { package_name: 'com.exemplo.app/../x', review_id: 'r1' });
    assert.equal(r.isError, true);
    assert.equal(g.calls.length, 0);
  });

  it('403 vira mensagem clara de permissao', async () => {
    const g = google().on('GET', /\/reviews\?/, { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } });
    const r = await run(g, 'listar_avaliacoes', { package_name: PKG });
    assert.equal(r.isError, true);
    assert.match(r.text, /conta de servico nao tem permissao .* no app com\.exemplo\.app/);
  });

  it('429 explica as cotas', async () => {
    const g = google().on('GET', /\/reviews\?/, { status: 429, body: { error: { message: 'Quota' } } });
    const r = await run(g, 'listar_avaliacoes', { package_name: PKG });
    assert.match(r.text, /200 leituras por hora/);
  });
});

describe('avaliacoes', () => {
  const review = {
    reviewId: 'gp:r1',
    authorName: 'Ana',
    comments: [
      {
        userComment: {
          text: 'Bom app',
          starRating: 5,
          reviewerLanguage: 'pt_BR',
          appVersionName: '1.2.0',
          appVersionCode: 12,
          device: 'a54',
          deviceMetadata: { manufacturer: 'Samsung', productName: 'Galaxy A54' },
          lastModified: { seconds: '1700000000' },
        },
      },
    ],
  };

  it('listar_avaliacoes formata os campos e repassa o token', async () => {
    const g = google().on('GET', /\/reviews\?/, { body: { reviews: [review], tokenPagination: { nextPageToken: 'abc' } } });
    const { data } = await run(g, 'listar_avaliacoes', { package_name: PKG, quantidade: 50 });
    assert.equal(data.proximo_token, 'abc');
    assert.deepEqual(data.avaliacoes[0], {
      review_id: 'gp:r1',
      autor: 'Ana',
      nota: 5,
      texto: 'Bom app',
      idioma: 'pt_BR',
      versao_app: '1.2.0',
      version_code: 12,
      aparelho: 'Samsung Galaxy A54',
      data: '2023-11-14T22:13:20.000Z',
      tem_resposta: false,
    });
    assert.match(g.apiCalls().at(-1)!.url, /maxResults=50/);
  });

  it('responder sem confirmar so mostra o resumo e nao publica', async () => {
    const g = google().on('GET', /\/reviews\/gp%3Ar1/, { body: review });
    const { data } = await run(g, 'responder_avaliacao', { package_name: PKG, review_id: 'gp:r1', texto: 'Obrigado!' });
    assert.equal(data.aplicado, false);
    assert.equal(data.nova_resposta, 'Obrigado!');
    assert.ok(!methods(g).some((m) => m.startsWith('POST')));
  });

  it('responder com confirmar publica a resposta', async () => {
    const g = google().on('POST', /:reply$/, { body: { result: { replyText: 'Obrigado!', lastEdited: { seconds: '1700000000' } } } });
    const { data } = await run(g, 'responder_avaliacao', { package_name: PKG, review_id: 'gp:r1', texto: 'Obrigado!', confirmar: true });
    assert.equal(data.aplicado, true);
    assert.deepEqual(g.apiCalls().at(-1)!.body, { replyText: 'Obrigado!' });
  });

  it('texto acima de 350 caracteres e recusado antes da API', async () => {
    const g = google();
    const r = await run(g, 'responder_avaliacao', { package_name: PKG, review_id: 'gp:r1', texto: 'x'.repeat(351), confirmar: true });
    assert.equal(r.isError, true);
    assert.ok(!methods(g).some((m) => m.includes('reviews')));
  });
});

describe('faixas e testadores', () => {
  it('listar_faixas le e descarta o edit sem commit', async () => {
    const g = google().on('GET', /\/edits\/edit1\/tracks$/, {
      body: { tracks: [{ track: 'internal', releases: [{ name: '1.2.0', status: 'completed', versionCodes: ['12'] }] }] },
    });
    const { data } = await run(g, 'listar_faixas', { package_name: PKG });
    assert.deepEqual(data.faixas, [{ faixa: 'internal', versoes: [{ nome: '1.2.0', status: 'concluido', version_codes: ['12'] }] }]);
    const m = methods(g);
    assert.ok(m.some((x) => x.startsWith('DELETE')));
    assert.ok(!m.some((x) => x.includes(':commit')));
  });

  it('alterar_testadores sem confirmar mostra antes e depois e descarta o edit', async () => {
    const g = google().on('GET', /\/testers\/alpha$/, { body: { googleGroups: ['antigo@googlegroups.com'] } });
    const { data } = await run(g, 'alterar_testadores', {
      package_name: PKG,
      faixa: 'alpha',
      adicionar: ['Novo@GoogleGroups.com'],
      remover: ['antigo@googlegroups.com'],
    });
    assert.equal(data.aplicado, false);
    assert.deepEqual(data.antes, ['antigo@googlegroups.com']);
    assert.deepEqual(data.depois, ['novo@googlegroups.com']);
    const m = methods(g);
    assert.ok(!m.some((x) => x.startsWith('PUT') || x.includes(':commit')));
    assert.ok(m.some((x) => x.startsWith('DELETE')));
  });

  it('alterar_testadores com confirmar faz PUT e commit no final', async () => {
    const g = google()
      .on('GET', /\/testers\/alpha$/, { body: { googleGroups: ['antigo@googlegroups.com'] } })
      .on('PUT', /\/testers\/alpha$/, (c) => ({ body: c.body }))
      .on('POST', /:commit/, { body: { id: 'edit1' } });
    const { data } = await run(g, 'alterar_testadores', { package_name: PKG, faixa: 'alpha', adicionar: ['novo@googlegroups.com'], confirmar: true });
    assert.equal(data.aplicado, true);
    const m = methods(g);
    assert.deepEqual(m.slice(-4), [
      'POST /androidpublisher/v3/applications/com.exemplo.app/edits',
      'GET /androidpublisher/v3/applications/com.exemplo.app/edits/edit1/testers/alpha',
      'PUT /androidpublisher/v3/applications/com.exemplo.app/edits/edit1/testers/alpha',
      'POST /androidpublisher/v3/applications/com.exemplo.app/edits/edit1:commit',
    ]);
    assert.deepEqual(g.apiCalls().find((c) => c.method === 'PUT')!.body, { googleGroups: ['antigo@googlegroups.com', 'novo@googlegroups.com'] });
  });

  it('erro no PUT descarta o edit e nao faz commit', async () => {
    const g = google()
      .on('GET', /\/testers\/alpha$/, { body: {} })
      .on('PUT', /\/testers\/alpha$/, { status: 400, body: { error: { message: 'Grupo invalido' } } });
    const r = await run(g, 'alterar_testadores', { package_name: PKG, faixa: 'alpha', adicionar: ['x@googlegroups.com'], confirmar: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /Grupo invalido/);
    const m = methods(g);
    assert.equal(m.at(-1), 'DELETE /androidpublisher/v3/applications/com.exemplo.app/edits/edit1');
    assert.ok(!m.some((x) => x.includes(':commit')));
  });

  it('erro no commit tambem descarta o edit', async () => {
    const g = google()
      .on('GET', /\/testers\/alpha$/, { body: {} })
      .on('PUT', /\/testers\/alpha$/, { body: {} })
      .on('POST', /:commit/, { status: 400, body: { error: { message: 'Changes are in review' } } });
    const r = await run(g, 'alterar_testadores', { package_name: PKG, faixa: 'alpha', adicionar: ['x@googlegroups.com'], confirmar: true });
    assert.equal(r.isError, true);
    assert.equal(methods(g).at(-1), 'DELETE /androidpublisher/v3/applications/com.exemplo.app/edits/edit1');
  });

  it('producao e recusada antes de abrir edit', async () => {
    const g = google();
    const r = await run(g, 'alterar_testadores', { package_name: PKG, faixa: 'production', adicionar: ['x@googlegroups.com'], confirmar: true });
    assert.equal(r.isError, true);
    assert.ok(!methods(g).some((x) => x.includes('/edits')));
  });
});

describe('produtos', () => {
  const product = {
    packageName: PKG,
    productId: 'moedas',
    listings: [{ languageCode: 'pt-BR', title: 'Moedas' }],
    purchaseOptions: [{ purchaseOptionId: 'compra', state: 'ACTIVE', buyOption: {} }],
  };

  it('salvar_produto existente exige campos', async () => {
    const g = google().on('GET', /oneTimeProducts\/moedas$/, { body: product });
    const r = await run(g, 'salvar_produto', { package_name: PKG, tipo: 'unico', product_id: 'moedas', produto: { listings: [] } });
    assert.equal(r.isError, true);
    assert.match(r.text, /informe campos/);
  });

  it('salvar_produto sem confirmar mostra antes e depois e nao grava', async () => {
    const g = google().on('GET', /oneTimeProducts\/moedas$/, { body: product });
    const novo = { listings: [{ languageCode: 'pt-BR', title: 'Moedas de ouro' }] };
    const { data } = await run(g, 'salvar_produto', { package_name: PKG, tipo: 'unico', product_id: 'moedas', produto: novo, campos: 'listings' });
    assert.equal(data.operacao, 'atualizar');
    assert.match(data.mudancas[0].depois, /Moedas de ouro/);
    assert.ok(!methods(g).some((m) => m.startsWith('PATCH')));
  });

  it('salvar_produto novo com confirmar cria via PATCH com allowMissing', async () => {
    const g = google()
      .on('GET', /oneTimeProducts\/novo$/, { status: 404, body: { error: { message: 'not found' } } })
      .on('PATCH', /onetimeproducts\/novo/, (c) => ({ body: c.body }));
    const { data } = await run(g, 'salvar_produto', {
      package_name: PKG,
      tipo: 'unico',
      product_id: 'novo',
      produto: { packageName: 'com.outro.app', listings: [{ languageCode: 'pt-BR', title: 'Novo' }], purchaseOptions: [] },
      confirmar: true,
    });
    assert.equal(data.operacao, 'criado');
    const patch = g.apiCalls().find((c) => c.method === 'PATCH')!;
    assert.match(patch.url, /allowMissing=true/);
    assert.match(patch.url, /regionsVersion\.version=2022%2F02/);
    assert.equal(patch.body.packageName, PKG); // nunca o app do corpo
  });

  it('mudar_estado_produto confere a opcao e usa batchUpdateStates', async () => {
    const g = google()
      .on('GET', /oneTimeProducts\/moedas$/, { body: product })
      .on('POST', /purchaseOptions:batchUpdateStates$/, { body: {} });
    const preview = await run(g, 'mudar_estado_produto', { package_name: PKG, tipo: 'unico', product_id: 'moedas', opcao_id: 'compra', acao: 'desativar' });
    assert.equal(preview.data.estado_atual, 'ACTIVE');
    assert.ok(!methods(g).some((m) => m.includes('batchUpdateStates')));

    const done = await run(g, 'mudar_estado_produto', { package_name: PKG, tipo: 'unico', product_id: 'moedas', opcao_id: 'compra', acao: 'desativar', confirmar: true });
    assert.equal(done.data.aplicado, true);
    assert.ok(g.apiCalls().at(-1)!.body.requests[0].deactivatePurchaseOptionRequest);

    const missing = await run(g, 'mudar_estado_produto', { package_name: PKG, tipo: 'unico', product_id: 'moedas', opcao_id: 'outra', acao: 'ativar', confirmar: true });
    assert.equal(missing.isError, true);
  });
});

describe('seguranca dos dados', () => {
  it('so envia com confirmar', async () => {
    const g = google().on('POST', /\/dataSafety$/, { body: {} });
    const csv = 'Question ID,Response ID,Response value\nPSL_DATA,,true';
    const preview = await run(g, 'atualizar_seguranca_dados', { package_name: PKG, csv });
    assert.equal(preview.data.aplicado, false);
    assert.ok(!methods(g).some((m) => m.includes('dataSafety')));
    const done = await run(g, 'atualizar_seguranca_dados', { package_name: PKG, csv, confirmar: true });
    assert.equal(done.data.aplicado, true);
    assert.deepEqual(g.apiCalls().at(-1)!.body, { safetyLabels: csv });
  });
});

describe('ferramenta desconhecida', () => {
  it('devolve erro', async () => {
    const r = await run(google(), 'apagar_tudo', {});
    assert.equal(r.isError, true);
  });
});
