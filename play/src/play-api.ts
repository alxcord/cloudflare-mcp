// Cliente das APIs do Google Play usadas pelo MCP.
//
// - Google Play Developer API (androidpublisher v3): avaliacoes, edits, faixas, testadores,
//   produtos e Seguranca dos dados.
// - Google Play Developer Reporting API (v1beta1): so apps:search, para listar os apps.
//
// Toda URL e montada aqui, com cada segmento passado por encodeURIComponent depois de validado
// em validate.ts. Os metodos so montam a chamada e devolvem o JSON: regras de negocio
// (confirmacao, resumo, descarte de edit) ficam em tools.ts.

import type { FetchFn } from './google-auth.ts';
import type { ProductKind } from './validate.ts';

export const PUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
export const REPORTING_BASE = 'https://playdeveloperreporting.googleapis.com/v1beta1';

// Timeout por chamada ao Google. Evita que uma chamada presa segure o Worker.
const API_TIMEOUT_MS = 30_000;

// Erro devolvido pela API do Google, ja sem nada sensivel (so status, status textual e mensagem).
export class GoogleApiError extends Error {
  readonly status: number;
  readonly googleStatus: string;

  constructor(status: number, googleStatus: string, message: string) {
    super(message);
    this.status = status;
    this.googleStatus = googleStatus;
  }
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
}

type Query = Record<string, string | number | boolean | undefined>;

// Monta a URL a partir de segmentos ja validados. Cada segmento e codificado: "/" ou "?" vindos
// de uma entrada nunca mudam o caminho. Sufixos de metodo (":reply", ":commit") vem do codigo.
export function buildUrl(base: string, segments: string[], suffix = '', query: Query = {}): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  const q = qs.toString();
  return `${base}/${path}${suffix}${q ? `?${q}` : ''}`;
}

// Recurso de produto conforme o tipo. O PATCH de produto unico usa "onetimeproducts" em minusculas
// (assim esta no discovery document oficial); os demais metodos usam "oneTimeProducts".
function productCollection(kind: ProductKind, forPatch = false): string {
  if (kind === 'assinatura') return 'subscriptions';
  return forPatch ? 'onetimeproducts' : 'oneTimeProducts';
}

export const requests = {
  searchApps(pageToken?: string): ApiRequest {
    return { method: 'GET', url: buildUrl(REPORTING_BASE, ['apps'], ':search', { pageSize: 1000, pageToken }) };
  },

  listReviews(pkg: string, opts: { maxResults: number; token?: string; translationLanguage?: string }): ApiRequest {
    return {
      method: 'GET',
      url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'reviews'], '', {
        maxResults: opts.maxResults,
        token: opts.token,
        translationLanguage: opts.translationLanguage,
      }),
    };
  },

  getReview(pkg: string, id: string, translationLanguage?: string): ApiRequest {
    return { method: 'GET', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'reviews', id], '', { translationLanguage }) };
  },

  replyReview(pkg: string, id: string, replyText: string): ApiRequest {
    return { method: 'POST', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'reviews', id], ':reply'), body: { replyText } };
  },

  insertEdit(pkg: string): ApiRequest {
    return { method: 'POST', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'edits']), body: {} };
  },

  deleteEdit(pkg: string, editId: string): ApiRequest {
    return { method: 'DELETE', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'edits', editId]) };
  },

  // ERROR_IF_IN_REVIEW: se houver mudancas em revisao (ex.: uma versao enviada pelo Actions),
  // o commit falha em vez de cancelar a revisao e reenviar tudo, que e o padrao da API.
  commitEdit(pkg: string, editId: string): ApiRequest {
    return {
      method: 'POST',
      url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'edits', editId], ':commit', { changesInReviewBehavior: 'ERROR_IF_IN_REVIEW' }),
    };
  },

  listTracks(pkg: string, editId: string): ApiRequest {
    return { method: 'GET', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'edits', editId, 'tracks']) };
  },

  getTesters(pkg: string, editId: string, track: string): ApiRequest {
    return { method: 'GET', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'edits', editId, 'testers', track]) };
  },

  // PUT substitui a lista inteira de grupos da faixa.
  updateTesters(pkg: string, editId: string, track: string, googleGroups: string[]): ApiRequest {
    return { method: 'PUT', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'edits', editId, 'testers', track]), body: { googleGroups } };
  },

  listProducts(pkg: string, kind: ProductKind, pageToken?: string): ApiRequest {
    return { method: 'GET', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, productCollection(kind)], '', { pageSize: 100, pageToken }) };
  },

  getProduct(pkg: string, kind: ProductKind, id: string): ApiRequest {
    return { method: 'GET', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, productCollection(kind), id]) };
  },

  // PATCH com allowMissing=true cria o produto se ele nao existir (nesse caso o updateMask e ignorado).
  patchProduct(pkg: string, kind: ProductKind, id: string, body: unknown, opts: { updateMask: string; regionsVersion: string }): ApiRequest {
    return {
      method: 'PATCH',
      url: buildUrl(PUBLISHER_BASE, ['applications', pkg, productCollection(kind, true), id], '', {
        updateMask: opts.updateMask,
        'regionsVersion.version': opts.regionsVersion,
        allowMissing: true,
      }),
      body,
    };
  },

  // Ativa ou desativa uma opcao de compra (produto unico) ou um plano base (assinatura).
  setOptionState(pkg: string, kind: ProductKind, id: string, option: string, action: 'ativar' | 'desativar'): ApiRequest {
    if (kind === 'assinatura') {
      const verb = action === 'ativar' ? ':activate' : ':deactivate';
      return {
        method: 'POST',
        url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'subscriptions', id, 'basePlans', option], verb),
        body: {},
      };
    }
    const field = action === 'ativar' ? 'activatePurchaseOptionRequest' : 'deactivatePurchaseOptionRequest';
    return {
      method: 'POST',
      url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'oneTimeProducts', id, 'purchaseOptions'], ':batchUpdateStates'),
      body: { requests: [{ [field]: { packageName: pkg, productId: id, purchaseOptionId: option } }] },
    };
  },

  dataSafety(pkg: string, csv: string): ApiRequest {
    return { method: 'POST', url: buildUrl(PUBLISHER_BASE, ['applications', pkg, 'dataSafety']), body: { safetyLabels: csv } };
  },
};

// Executa chamadas autenticadas e converte erros do Google em GoogleApiError.
export class PlayApi {
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: FetchFn;

  constructor(getToken: () => Promise<string>, fetchFn: FetchFn = (i, init) => fetch(i, init)) {
    this.getToken = getToken;
    this.fetchFn = fetchFn;
  }

  async call<T = any>(req: ApiRequest): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(req.url, { method: req.method, headers, body, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    } catch (e) {
      const name = (e as Error)?.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de rede';
      throw new GoogleApiError(0, 'UNAVAILABLE', `Nao foi possivel falar com a API do Google (${name})`);
    }

    const raw = await res.text();
    if (!res.ok) {
      // Formato de erro do Google: { error: { code, status, message } }. A mensagem nao traz
      // token nem chave, mas e cortada para nao inflar a resposta.
      let status = '';
      let message = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(raw) as { error?: { status?: string; message?: string } };
        status = data.error?.status ?? '';
        if (data.error?.message) message = data.error.message.slice(0, 300);
      } catch {
        // corpo nao e JSON: fica so o status HTTP
      }
      throw new GoogleApiError(res.status, status, message);
    }
    if (!raw) return {} as T;
    return JSON.parse(raw) as T;
  }
}
