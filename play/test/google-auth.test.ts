// Testes da assinatura do JWT RS256 e do cache do access token do Google.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { GoogleTokenProvider, pemToDer, SCOPES, signServiceAccountJwt, TOKEN_URL } from '../src/google-auth.ts';
import { decodeJwtPart, generateTestKey, MockGoogle } from './helpers.ts';

let pem = '';
let publicKey: CryptoKey;
const EMAIL = 'mcp-play@projeto-teste.iam.gserviceaccount.com';

before(async () => {
  ({ pem, publicKey } = await generateTestKey());
});

describe('pemToDer', () => {
  it('aceita quebras de linha reais e "\\n" literal', () => {
    const literal = pem.replace(/\n/g, '\\n');
    assert.deepEqual(pemToDer(literal), pemToDer(pem));
  });

  it('recusa texto que nao e PEM PKCS#8', () => {
    assert.throws(() => pemToDer('nao e chave'), /PEM PKCS#8/);
    assert.throws(() => pemToDer('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'), /PEM PKCS#8/);
  });
});

describe('signServiceAccountJwt', () => {
  it('gera JWT RS256 com as claims esperadas e assinatura valida', async () => {
    const jwt = await signServiceAccountJwt({ email: EMAIL, privateKeyPem: pem }, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(decodeJwtPart(h), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(decodeJwtPart(c), {
      iss: EMAIL,
      scope: SCOPES.join(' '),
      aud: TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (ch) => ch.charCodeAt(0));
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, new TextEncoder().encode(`${h}.${c}`));
    assert.equal(ok, true);
  });
});

describe('GoogleTokenProvider', () => {
  it('troca o JWT por token e reutiliza o cache ate perto de expirar', async () => {
    let now = 1_700_000_000;
    let issued = 0;
    const google = new MockGoogle().on('POST', /oauth2\.googleapis\.com\/token$/, (call) => {
      const params = new URLSearchParams(call.body as string);
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(params.get('assertion')?.split('.').length, 3);
      issued++;
      return { body: { access_token: `tok-${issued}`, expires_in: 3600 } };
    });
    const tokens = new GoogleTokenProvider(google.fetch, () => now);
    const sa = { email: EMAIL, privateKeyPem: pem };

    assert.equal(await tokens.getToken(sa), 'tok-1');
    now += 3000;
    assert.equal(await tokens.getToken(sa), 'tok-1'); // ainda no cache
    now += 600 - 59; // a menos de 60 s do fim: renova
    assert.equal(await tokens.getToken(sa), 'tok-2');
    assert.equal(google.calls.length, 2);
  });

  it('erro do Google nao expoe o JWT nem a chave', async () => {
    const google = new MockGoogle().on('POST', /token$/, { status: 400, body: { error: 'invalid_grant', error_description: 'x' } });
    const tokens = new GoogleTokenProvider(google.fetch, () => 1_700_000_000);
    await assert.rejects(
      () => tokens.getToken({ email: EMAIL, privateKeyPem: pem }),
      (e: Error) => {
        assert.match(e.message, /invalid_grant/);
        assert.doesNotMatch(e.message, /eyJ|PRIVATE KEY/);
        return true;
      },
    );
  });
});
