// Testes das validacoes de entrada.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as v from '../src/validate.ts';

describe('packageName', () => {
  it('aceita package names validos', () => {
    assert.equal(v.packageName('com.exemplo.app'), 'com.exemplo.app');
    assert.equal(v.packageName(' dev.exemplo.app_2 '), 'dev.exemplo.app_2');
  });

  it('recusa caminhos, caracteres de URL e formatos invalidos', () => {
    for (const bad of ['app', 'com/exemplo', 'com.exemplo/../x', 'com.exemplo%2Fx', 'com.exemplo?x=1', 'com.exemplo#x', '1com.x', 'com..x', 'com.x.', '', 'com.ex emplo', 123]) {
      assert.throws(() => v.packageName(bad), v.ValidationError, String(bad));
    }
  });
});

describe('email e emailList', () => {
  it('normaliza para minusculas e remove duplicados', () => {
    assert.deepEqual(v.emailList(['Testers@GoogleGroups.com', 'testers@googlegroups.com'], 'adicionar'), ['testers@googlegroups.com']);
  });

  it('recusa formatos invalidos', () => {
    for (const bad of ['sem-arroba', 'a@b', 'a@b.c/d', 'a b@x.com', '<x>@y.com']) {
      assert.throws(() => v.email(bad), v.ValidationError, bad);
    }
    assert.throws(() => v.emailList('x@y.com', 'adicionar'), /lista/);
  });
});

describe('testTrack', () => {
  it('aceita faixas de teste e recusa producao', () => {
    assert.equal(v.testTrack('internal'), 'internal');
    assert.equal(v.testTrack('Closed testing - Alpha'), 'Closed testing - Alpha');
    assert.throws(() => v.testTrack('production'), /producao/);
    assert.throws(() => v.testTrack('wear:production'), /producao/);
    assert.throws(() => v.testTrack('../edits'), v.ValidationError);
  });
});

describe('replyText', () => {
  it('aceita ate 350 caracteres e conta emoji como 1', () => {
    assert.equal(v.replyText('a'.repeat(350)).length, 350);
    assert.equal(v.replyText('😀'.repeat(350)), '😀'.repeat(350));
    assert.throws(() => v.replyText('a'.repeat(351)), /351 caracteres/);
  });

  it('remove caracteres de controle e recusa HTML e texto vazio', () => {
    assert.equal(v.replyText('  Obrigado!\u0007\r\nAbracos  '), 'Obrigado!\nAbracos');
    assert.throws(() => v.replyText('<b>oi</b>'), /HTML/);
    assert.throws(() => v.replyText('   '), /vazio/);
  });
});

describe('ids, tipos e mascaras', () => {
  it('reviewId', () => {
    assert.equal(v.reviewId('gp:AOqpTOE_x-1.2'), 'gp:AOqpTOE_x-1.2');
    assert.throws(() => v.reviewId('gp/../x'), v.ValidationError);
  });

  it('productId e optionId', () => {
    assert.equal(v.productId('premium_1.mensal'), 'premium_1.mensal');
    assert.throws(() => v.productId('Premium'), v.ValidationError);
    assert.throws(() => v.productId('_x'), v.ValidationError);
    assert.equal(v.optionId('plano-anual'), 'plano-anual');
    assert.throws(() => v.optionId('plano_anual'), v.ValidationError);
  });

  it('productKind, stateAction e mascara', () => {
    assert.equal(v.productKind('assinatura'), 'assinatura');
    assert.throws(() => v.productKind('outro'), v.ValidationError);
    assert.equal(v.stateAction('ativar'), 'ativar');
    assert.equal(v.optionalUpdateMask('listings, purchaseOptions'), 'listings,purchaseOptions');
    assert.equal(v.optionalUpdateMask(['listings', 'taxAndComplianceSettings.isTokenizedDigitalAsset']), 'listings,taxAndComplianceSettings.isTokenizedDigitalAsset');
    assert.throws(() => v.optionalUpdateMask('listings&x=1'), v.ValidationError);
  });

  it('regionsVersion, idioma, pagina e inteiros', () => {
    assert.equal(v.regionsVersion(undefined), v.DEFAULT_REGIONS_VERSION);
    assert.throws(() => v.regionsVersion('2022-02'), v.ValidationError);
    assert.equal(v.optionalLanguage('pt_BR'), 'pt_BR');
    assert.throws(() => v.optionalLanguage('pt&x'), v.ValidationError);
    assert.throws(() => v.optionalPageToken('a b'), v.ValidationError);
    assert.equal(v.intInRange(undefined, 'q', 1, 100, 20), 20);
    assert.throws(() => v.intInRange(101, 'q', 1, 100, 20), v.ValidationError);
  });
});

describe('productBody', () => {
  it('forca packageName e productId dos parametros validados', () => {
    const body = v.productBody({ packageName: 'com.outro.app', productId: 'outro', listings: [] }, 'com.exemplo.app', 'premium');
    assert.equal(body.packageName, 'com.exemplo.app');
    assert.equal(body.productId, 'premium');
  });

  it('aceita string JSON e recusa lista ou JSON invalido', () => {
    assert.deepEqual(v.productBody('{"listings":[]}', 'com.a.b', 'p').listings, []);
    assert.throws(() => v.productBody('[1]', 'com.a.b', 'p'), v.ValidationError);
    assert.throws(() => v.productBody('{x', 'com.a.b', 'p'), v.ValidationError);
  });
});

describe('dataSafetyCsv e confirmacao', () => {
  it('valida o CSV', () => {
    const r = v.dataSafetyCsv('﻿Question ID,Response ID,Response value\r\nPSL_DATA,,true\r\n');
    assert.equal(r.lines, 2);
    assert.match(r.header, /^Question ID/);
    assert.throws(() => v.dataSafetyCsv('so uma linha'), v.ValidationError);
    assert.throws(() => v.dataSafetyCsv('a,b\n\u0001,c'), /controle/);
  });

  it('so true libera a escrita', () => {
    assert.equal(v.isConfirmed(true), true);
    assert.equal(v.isConfirmed('true'), true);
    for (const x of [false, 'sim', 1, undefined, null]) assert.equal(v.isConfirmed(x), false);
  });
});
