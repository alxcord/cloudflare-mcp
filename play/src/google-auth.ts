// Autenticacao no Google com conta de servico (OAuth 2.0 server-to-server).
//
// Fluxo: monta um JWT RS256 assinado com a chave privada da conta de servico (WebCrypto),
// troca esse JWT por um access token em https://oauth2.googleapis.com/token e guarda o
// token em memoria ate perto de expirar. Nada disso vai para log.

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Escopos pedidos num unico token: a API de publicacao e a de relatorios (listagem de apps).
export const SCOPES = [
  'https://www.googleapis.com/auth/androidpublisher',
  'https://www.googleapis.com/auth/playdeveloperreporting',
];

// O Google aceita JWT com validade de no maximo 1 hora.
const JWT_TTL_SECONDS = 3600;
// Renova o access token 60 s antes de expirar, para nao usar um token no limite.
const REFRESH_MARGIN_SECONDS = 60;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServiceAccount {
  email: string;
  privateKeyPem: string;
}

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return b64urlEncode(enc.encode(JSON.stringify(obj)));
}

// Converte a chave PEM (PKCS#8, "BEGIN PRIVATE KEY") em bytes DER.
// Aceita "\n" literal, comum quando a chave e colada como string do JSON da conta de servico.
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = pem.replace(/\\n/g, '\n').trim();
  const match = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!match) throw new Error('GOOGLE_SA_PRIVATE_KEY nao esta no formato PEM PKCS#8 (BEGIN PRIVATE KEY)');
  const body = match[1].replace(/\s+/g, '');
  const binary = atob(body);
  const der = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

// Importa a chave privada para assinar com RS256 (RSASSA-PKCS1-v1_5 + SHA-256). Nao exportavel.
export function importSigningKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// Monta e assina o JWT que o Google troca por um access token.
export async function signServiceAccountJwt(sa: ServiceAccount, nowSeconds: number, key?: CryptoKey): Promise<string> {
  const signingKey = key ?? (await importSigningKey(sa.privateKeyPem));
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = b64urlJson({
    iss: sa.email,
    scope: SCOPES.join(' '),
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + JWT_TTL_SECONDS,
  });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64urlEncode(new Uint8Array(signature))}`;
}

// Provedor de access token com cache. Uma instancia por isolate do Worker (variavel de modulo).
export class GoogleTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private key: CryptoKey | null = null;
  private keyFor = ''; // email da conta cuja chave esta importada (troca de secret invalida o cache)

  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  // fetchFn e now sao injetaveis para os testes (API mockada e relogio fixo).
  constructor(fetchFn: FetchFn = (i, init) => fetch(i, init), now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.fetchFn = fetchFn;
    this.now = now;
  }

  async getToken(sa: ServiceAccount): Promise<string> {
    const now = this.now();
    if (this.cached && this.keyFor === sa.email && now < this.cached.expiresAt - REFRESH_MARGIN_SECONDS) {
      return this.cached.token;
    }
    if (!this.key || this.keyFor !== sa.email) {
      this.key = await importSigningKey(sa.privateKeyPem);
      this.keyFor = sa.email;
      this.cached = null;
    }

    const assertion = await signServiceAccountJwt(sa, now, this.key);
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) {
      // O corpo de erro do Google so traz "error" e "error_description", sem segredo. Mesmo assim
      // so repassamos o codigo do erro, nunca o JWT enviado.
      let code = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (typeof data.error === 'string') code = data.error.slice(0, 60);
      } catch {
        // corpo nao e JSON: fica so o status
      }
      throw new Error(`O Google recusou a conta de servico (${code}). Confira GOOGLE_SA_EMAIL e GOOGLE_SA_PRIVATE_KEY.`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof data.access_token !== 'string') throw new Error('Resposta de token do Google sem access_token');
    const ttl = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.cached = { token: data.access_token, expiresAt: now + ttl };
    return data.access_token;
  }
}
