// Utilitarios dos testes: chave RSA de teste gerada na hora e fetch mockado com registro das chamadas.
// Nenhuma chave real entra no repositorio.

import { b64urlEncode } from '../src/google-auth.ts';

export async function generateTestKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

type Route = { method: string; match: RegExp; respond: (call: RecordedCall) => { status?: number; body?: unknown } };

// Fetch falso: cada rota casa metodo + regex da URL. Chamada sem rota falha o teste.
export class MockGoogle {
  calls: RecordedCall[] = [];
  private routes: Route[] = [];

  on(method: string, match: RegExp, respond: Route['respond'] | { status?: number; body?: unknown }): this {
    this.routes.push({ method, match, respond: typeof respond === 'function' ? respond : () => respond });
    return this;
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: any;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { method, url: input, headers, body };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && r.match.test(input));
    if (!route) throw new Error(`Chamada sem mock: ${method} ${input}`);
    const { status = 200, body: resBody } = route.respond(call);
    return new Response(resBody === undefined ? null : JSON.stringify(resBody), { status, headers: { 'Content-Type': 'application/json' } });
  };

  // Chamadas que nao sao para o endpoint de token do Google.
  apiCalls(): RecordedCall[] {
    return this.calls.filter((c) => !c.url.startsWith('https://oauth2.googleapis.com/'));
  }
}

export function decodeJwtPart(part: string): any {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(atob(b64));
}

export { b64urlEncode };
