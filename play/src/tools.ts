// Ferramentas MCP do Play Console: definicoes (nome, descricao, schema) e implementacao.
//
// Regras comuns:
// - Toda ferramenta por app recebe package_name, validado por formato e aceito so se estiver
//   na listagem de apps da conta de servico (apps:search, em cache por 10 minutos).
// - Ferramentas que escrevem so aplicam com confirmar=true. Sem isso, devolvem um resumo do que
//   vai mudar e nao alteram nada.
// - Mudancas de testadores usam um edit: commit so no final e descarte do edit em qualquer erro.

import { GoogleApiError, type PlayApi, requests } from './play-api.ts';
import * as v from './validate.ts';
import { ValidationError } from './validate.ts';

export interface ToolContext {
  api: PlayApi;
}

type Args = Record<string, unknown>;

// ---------- Cache da listagem de apps ----------

const APPS_TTL_MS = 10 * 60 * 1000;
let appsCache: { at: number; apps: { nome: string; package_name: string }[] } | null = null;

// Usado pelos testes para comecar cada caso com o cache vazio.
export function resetAppsCache(): void {
  appsCache = null;
}

async function fetchApps(ctx: ToolContext): Promise<{ nome: string; package_name: string }[]> {
  const apps: { nome: string; package_name: string }[] = [];
  let pageToken: string | undefined;
  // No maximo 5 paginas de 1000 apps: limite de seguranca contra laco infinito.
  for (let page = 0; page < 5; page++) {
    const data = await ctx.api.call<{ apps?: { packageName?: string; displayName?: string }[]; nextPageToken?: string }>(
      requests.searchApps(pageToken),
    );
    for (const a of data.apps ?? []) {
      if (typeof a.packageName === 'string') apps.push({ nome: a.displayName ?? '', package_name: a.packageName });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  appsCache = { at: Date.now(), apps };
  return apps;
}

async function listApps(ctx: ToolContext, force = false) {
  if (!force && appsCache && Date.now() - appsCache.at < APPS_TTL_MS) return appsCache.apps;
  return fetchApps(ctx);
}

// Valida o formato e confere se o app esta na conta. Se nao estiver no cache, recarrega uma vez
// (cobre um app recem-criado) antes de recusar.
async function requireApp(ctx: ToolContext, value: unknown): Promise<string> {
  const pkg = v.packageName(value);
  if ((await listApps(ctx)).some((a) => a.package_name === pkg)) return pkg;
  if ((await listApps(ctx, true)).some((a) => a.package_name === pkg)) return pkg;
  throw new ValidationError(`O app ${pkg} nao aparece entre os apps a que a conta de servico tem acesso. Use listar_apps para ver os disponiveis.`);
}

// ---------- Erros ----------

// Converte qualquer erro numa mensagem clara para o usuario, sem token nem chave.
export function friendlyError(e: unknown, pkg?: string): string {
  if (e instanceof ValidationError) return e.message;
  if (e instanceof GoogleApiError) {
    const app = pkg ? ` no app ${pkg}` : '';
    switch (e.status) {
      case 401:
        return 'O Google recusou o token da conta de servico. Confira os secrets GOOGLE_SA_EMAIL e GOOGLE_SA_PRIVATE_KEY.';
      case 403:
        return `A conta de servico nao tem permissao para esta operacao${app}. Confira as permissoes dela em Usuarios e permissoes do Play Console. Detalhe do Google: ${e.message}`;
      case 404:
        return `Nao encontrado${app}. Detalhe do Google: ${e.message}`;
      case 429:
        return 'Cota da API do Google esgotada. Avaliacoes: 200 leituras por hora e 2.000 respostas por dia, por app. Tente de novo mais tarde.';
      case 400:
      case 409:
        return `A API do Google recusou o pedido${app}: ${e.message}`;
      default:
        return `Erro da API do Google (${e.status || 'rede'})${app}: ${e.message}`;
    }
  }
  // Erros internos (ex.: secret mal formatado) ja tem mensagem sem dado sensivel.
  return e instanceof Error ? e.message : 'Erro inesperado';
}

// ---------- Edits ----------

// Abre um edit e executa fn. fn decide se o edit recebe commit (so com mudanca confirmada) ou e
// descartado. Em qualquer erro o edit e descartado, para nao deixar um edit aberto que atrapalhe
// o deploy do GitHub Actions.
async function withEdit<T>(ctx: ToolContext, pkg: string, fn: (editId: string) => Promise<{ commit: boolean; value: T }>): Promise<T> {
  const edit = await ctx.api.call<{ id?: string }>(requests.insertEdit(pkg));
  if (typeof edit.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(edit.id)) throw new Error('A API devolveu um edit sem id valido');
  const editId = edit.id;
  try {
    const decision = await fn(editId);
    if (decision.commit) await ctx.api.call(requests.commitEdit(pkg, editId));
    else await discardEdit(ctx, pkg, editId);
    return decision.value;
  } catch (e) {
    await discardEdit(ctx, pkg, editId);
    throw e;
  }
}

async function discardEdit(ctx: ToolContext, pkg: string, editId: string): Promise<void> {
  try {
    await ctx.api.call(requests.deleteEdit(pkg, editId));
  } catch {
    // Edit ja expirado ou ja apagado: nao ha o que fazer. O Google expira edits abertos sozinho.
  }
}

// ---------- Formatacao ----------

function isoFromTimestamp(ts: { seconds?: string | number } | undefined): string | undefined {
  if (!ts || ts.seconds === undefined) return undefined;
  const ms = Number(ts.seconds) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// Reduz a avaliacao do Google aos campos uteis, com nomes em portugues.
export function formatReview(r: any) {
  const comments: any[] = Array.isArray(r?.comments) ? r.comments : [];
  const user = comments.find((c) => c.userComment)?.userComment ?? {};
  const dev = comments.find((c) => c.developerComment)?.developerComment;
  const meta = user.deviceMetadata ?? {};
  const aparelho = [meta.manufacturer, meta.productName].filter(Boolean).join(' ') || user.device || undefined;
  return {
    review_id: r?.reviewId,
    autor: r?.authorName,
    nota: user.starRating,
    texto: user.text,
    texto_original: user.originalText || undefined,
    idioma: user.reviewerLanguage,
    versao_app: user.appVersionName,
    version_code: user.appVersionCode,
    android_sdk: user.androidOsVersion,
    aparelho,
    data: isoFromTimestamp(user.lastModified),
    tem_resposta: Boolean(dev),
    resposta: dev ? { texto: dev.text, data: isoFromTimestamp(dev.lastModified) } : undefined,
  };
}

const RELEASE_STATUS: Record<string, string> = {
  draft: 'rascunho',
  inProgress: 'em andamento',
  halted: 'suspenso',
  completed: 'concluido',
};

export function formatTracks(data: any) {
  const tracks: any[] = Array.isArray(data?.tracks) ? data.tracks : [];
  return tracks.map((t) => ({
    faixa: t.track,
    versoes: (Array.isArray(t.releases) ? t.releases : []).map((r: any) => ({
      nome: r.name,
      status: RELEASE_STATUS[r.status] ?? r.status,
      version_codes: r.versionCodes ?? [],
      fracao_usuarios: r.userFraction,
    })),
  }));
}

function productSummary(kind: v.ProductKind, p: any) {
  const titulos: Record<string, string> = {};
  for (const l of Array.isArray(p?.listings) ? p.listings : []) if (l?.languageCode) titulos[l.languageCode] = l.title;
  if (kind === 'assinatura') {
    return {
      product_id: p?.productId,
      titulos,
      planos_base: (Array.isArray(p?.basePlans) ? p.basePlans : []).map((b: any) => ({ id: b.basePlanId, estado: b.state })),
    };
  }
  return {
    product_id: p?.productId,
    titulos,
    opcoes_compra: (Array.isArray(p?.purchaseOptions) ? p.purchaseOptions : []).map((o: any) => ({ id: o.purchaseOptionId, estado: o.state })),
  };
}

// Corta um JSON para caber no resumo de confirmacao.
function preview(value: unknown, max = 2000): string {
  const s = JSON.stringify(value ?? null);
  return s.length > max ? `${s.slice(0, max)}... (cortado)` : s;
}

// ---------- Definicoes ----------

const PKG = { type: 'string', description: 'Package name do app, ex.: com.exemplo.app. Precisa estar em listar_apps.' };
const CONFIRMAR = {
  type: 'boolean',
  description: 'false (padrao) devolve so o resumo do que vai mudar. true aplica a mudanca. Mostre o resumo ao usuario antes de chamar com true.',
};
const TIPO = { type: 'string', enum: ['unico', 'assinatura'], description: 'unico = produto de compra unica. assinatura = assinatura.' };

export const TOOLS = [
  {
    name: 'listar_apps',
    description: 'Lista os apps (nome e package name) a que a conta de servico tem acesso no Play Console. Usa a Google Play Developer Reporting API.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'listar_avaliacoes',
    description:
      'Lista avaliacoes recentes de um app: nota, texto, idioma, versao, aparelho, data e se ja tem resposta. Limites da API do Google: ' +
      'so avaliacoes com texto, so da versao de producao (feedback de testadores nao vem), so as criadas ou alteradas nos ultimos 7 dias. ' +
      'Cota: 200 leituras por hora por app (cada chamada gasta 1). Use proximo_token para a pagina seguinte.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: PKG,
        quantidade: { type: 'integer', minimum: 1, maximum: 100, description: 'Avaliacoes por pagina (1 a 100, padrao 20)' },
        token: { type: 'string', description: 'proximo_token devolvido pela chamada anterior' },
        idioma_traducao: { type: 'string', description: 'Opcional. Traduz o texto para este idioma, ex.: pt' },
      },
      required: ['package_name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ler_avaliacao',
    description: 'Le uma avaliacao pelo review_id, com a resposta atual se houver. Gasta 1 da cota de 200 leituras por hora por app.',
    inputSchema: {
      type: 'object',
      properties: { package_name: PKG, review_id: { type: 'string' }, idioma_traducao: { type: 'string' } },
      required: ['package_name', 'review_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'responder_avaliacao',
    description:
      'Responde uma avaliacao ou substitui a resposta existente. Texto puro, ate 350 caracteres (limite do Google), sem HTML. ' +
      'A resposta e publica. O usuario so e notificado na primeira resposta, nao nas edicoes. ' +
      'Cota: 2.000 respostas por dia por app. O resumo (confirmar=false) le a avaliacao e gasta 1 da cota de leituras.',
    inputSchema: {
      type: 'object',
      properties: { package_name: PKG, review_id: { type: 'string' }, texto: { type: 'string', maxLength: 350 }, confirmar: CONFIRMAR },
      required: ['package_name', 'review_id', 'texto'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'listar_faixas',
    description:
      'Somente leitura. Mostra as faixas do app (producao, teste interno, fechado, aberto) com as versoes, version codes e status ' +
      '(rascunho, em andamento, suspenso, concluido). Abre um edit temporario e descarta sem commit.',
    inputSchema: { type: 'object', properties: { package_name: PKG }, required: ['package_name'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ver_testadores',
    description:
      'Mostra os Grupos do Google associados a uma faixa de teste. A API so trabalha com Grupos do Google: listas de e-mail ' +
      'criadas no Console nao aparecem aqui.',
    inputSchema: {
      type: 'object',
      properties: { package_name: PKG, faixa: { type: 'string', description: 'internal, alpha, beta ou o nome da faixa fechada' } },
      required: ['package_name', 'faixa'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'alterar_testadores',
    description:
      'Associa ou desassocia Grupos do Google de uma faixa de teste. Membros do grupo sao geridos em groups.google.com (sem API para grupos comuns). ' +
      'Usa um edit e faz commit so no final. O commit falha se houver mudancas em revisao, para nao cancelar uma revisao. ' +
      'Atencao: o commit invalida outros edits abertos do app, entao evite rodar durante um deploy do GitHub Actions.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: PKG,
        faixa: { type: 'string', description: 'internal, alpha, beta ou o nome da faixa fechada (producao e recusada)' },
        adicionar: { type: 'array', items: { type: 'string' }, description: 'E-mails dos grupos a associar' },
        remover: { type: 'array', items: { type: 'string' }, description: 'E-mails dos grupos a desassociar' },
        confirmar: CONFIRMAR,
      },
      required: ['package_name', 'faixa'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'listar_produtos',
    description: 'Lista produtos de compra unica ou assinaturas do app, com titulos e estado das opcoes de compra ou planos base.',
    inputSchema: {
      type: 'object',
      properties: { package_name: PKG, tipo: TIPO, token: { type: 'string', description: 'proximo_token da chamada anterior' } },
      required: ['package_name', 'tipo'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ler_produto',
    description: 'Le o JSON completo de um produto de compra unica ou de uma assinatura (formato da API monetization do Google).',
    inputSchema: {
      type: 'object',
      properties: { package_name: PKG, tipo: TIPO, product_id: { type: 'string' } },
      required: ['package_name', 'tipo', 'product_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'salvar_produto',
    description:
      'Cria ou atualiza um produto de compra unica (OneTimeProduct) ou uma assinatura (Subscription) no formato da API monetization do Google. ' +
      'Para atualizar, informe campos (updateMask), ex.: listings ou purchaseOptions. Na criacao, campos e ignorado. ' +
      'Estados de opcoes e planos nao mudam aqui: use mudar_estado_produto. Leia o produto antes com ler_produto para partir do JSON atual.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: PKG,
        tipo: TIPO,
        product_id: { type: 'string' },
        produto: { type: 'object', description: 'JSON do produto. packageName e productId sao preenchidos pelo MCP.' },
        campos: { type: 'string', description: 'Campos a atualizar, separados por virgula (obrigatorio se o produto ja existe)' },
        versao_regioes: { type: 'string', description: 'Versao das regioes de preco (padrao 2022/02)' },
        confirmar: CONFIRMAR,
      },
      required: ['package_name', 'tipo', 'product_id', 'produto'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'mudar_estado_produto',
    description:
      'Ativa ou desativa uma opcao de compra (produto unico) ou um plano base (assinatura). Desativar uma opcao impede novas compras dela.',
    inputSchema: {
      type: 'object',
      properties: {
        package_name: PKG,
        tipo: TIPO,
        product_id: { type: 'string' },
        opcao_id: { type: 'string', description: 'purchaseOptionId (produto unico) ou basePlanId (assinatura)' },
        acao: { type: 'string', enum: ['ativar', 'desativar'] },
        confirmar: CONFIRMAR,
      },
      required: ['package_name', 'tipo', 'product_id', 'opcao_id', 'acao'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'atualizar_seguranca_dados',
    description:
      'Envia a declaracao de Seguranca dos dados do app como CSV (modelo exportado do Play Console). Substitui a declaracao inteira. ' +
      'A API nao tem leitura dessa declaracao, entao o resumo nao compara com a versao publicada: guarde o CSV como fonte.',
    inputSchema: {
      type: 'object',
      properties: { package_name: PKG, csv: { type: 'string', description: 'Conteudo completo do CSV' }, confirmar: CONFIRMAR },
      required: ['package_name', 'csv'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

// ---------- Implementacao ----------

type Handler = (ctx: ToolContext, args: Args) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async listar_apps(ctx) {
    const apps = await listApps(ctx, true);
    return { total: apps.length, apps };
  },

  async listar_avaliacoes(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const maxResults = v.intInRange(args.quantidade, 'quantidade', 1, 100, 20);
    const data = await ctx.api.call<any>(
      requests.listReviews(pkg, { maxResults, token: v.optionalPageToken(args.token), translationLanguage: v.optionalLanguage(args.idioma_traducao) }),
    );
    const reviews = (Array.isArray(data.reviews) ? data.reviews : []).map(formatReview);
    return {
      total_nesta_pagina: reviews.length,
      avaliacoes: reviews,
      proximo_token: data.tokenPagination?.nextPageToken,
      aviso: 'So avaliacoes com texto, de producao, criadas ou alteradas nos ultimos 7 dias.',
    };
  },

  async ler_avaliacao(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const id = v.reviewId(args.review_id);
    return formatReview(await ctx.api.call(requests.getReview(pkg, id, v.optionalLanguage(args.idioma_traducao))));
  },

  async responder_avaliacao(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const id = v.reviewId(args.review_id);
    const texto = v.replyText(args.texto);

    if (!v.isConfirmed(args.confirmar)) {
      const review = formatReview(await ctx.api.call(requests.getReview(pkg, id)));
      return {
        aplicado: false,
        resumo: review.tem_resposta ? 'Vai SUBSTITUIR a resposta atual (o usuario nao recebe nova notificacao).' : 'Vai publicar a primeira resposta (o usuario e notificado).',
        avaliacao: { nota: review.nota, texto: review.texto, autor: review.autor },
        resposta_atual: review.resposta?.texto,
        nova_resposta: texto,
        caracteres: [...texto].length,
        proximo_passo: 'Chame de novo com confirmar=true para publicar.',
      };
    }

    const result = await ctx.api.call<any>(requests.replyReview(pkg, id, texto));
    return { aplicado: true, resposta: result.result?.replyText ?? texto, data: isoFromTimestamp(result.result?.lastEdited) };
  },

  async listar_faixas(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    // Edit so para leitura: descartado no final, sem commit.
    const data = await withEdit(ctx, pkg, async (editId) => ({ commit: false, value: await ctx.api.call(requests.listTracks(pkg, editId)) }));
    return { package_name: pkg, faixas: formatTracks(data) };
  },

  async ver_testadores(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const track = v.testTrack(args.faixa);
    const data = await withEdit(ctx, pkg, async (editId) => ({
      commit: false,
      value: await ctx.api.call<{ googleGroups?: string[] }>(requests.getTesters(pkg, editId, track)),
    }));
    return { faixa: track, grupos_google: data.googleGroups ?? [] };
  },

  async alterar_testadores(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const track = v.testTrack(args.faixa);
    const add = v.emailList(args.adicionar, 'adicionar');
    const remove = v.emailList(args.remover, 'remover');
    if (add.length === 0 && remove.length === 0) throw new ValidationError('informe ao menos um grupo em adicionar ou remover');
    const conflict = add.filter((g) => remove.includes(g));
    if (conflict.length) throw new ValidationError(`o mesmo grupo esta em adicionar e remover: ${conflict.join(', ')}`);
    const confirmed = v.isConfirmed(args.confirmar);

    // O commit so acontece se houver mudanca e confirmar=true. Nos outros casos o edit e descartado.
    return withEdit(ctx, pkg, async (editId) => {
      const current = (await ctx.api.call<{ googleGroups?: string[] }>(requests.getTesters(pkg, editId, track))).googleGroups ?? [];
      const currentLower = current.map((g) => g.toLowerCase());
      const toAdd = add.filter((g) => !currentLower.includes(g));
      const toRemove = remove.filter((g) => currentLower.includes(g));
      const next = [...current.filter((g) => !toRemove.includes(g.toLowerCase())), ...toAdd];
      const changed = toAdd.length > 0 || toRemove.length > 0;
      const base = {
        faixa: track,
        antes: current,
        depois: next,
        adicionados: toAdd,
        removidos: toRemove,
        ignorados: [...add.filter((g) => !toAdd.includes(g)), ...remove.filter((g) => !toRemove.includes(g))],
      };
      if (!changed) return { commit: false, value: { aplicado: false, ...base, resumo: 'Nada a mudar: a faixa ja esta assim.' } };
      if (!confirmed) {
        return { commit: false, value: { aplicado: false, ...base, proximo_passo: 'Chame de novo com confirmar=true para aplicar.' } };
      }
      await ctx.api.call(requests.updateTesters(pkg, editId, track, next));
      return { commit: true, value: { aplicado: true, ...base } };
    });
  },

  async listar_produtos(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const kind = v.productKind(args.tipo);
    const data = await ctx.api.call<any>(requests.listProducts(pkg, kind, v.optionalPageToken(args.token)));
    const list = kind === 'assinatura' ? data.subscriptions : data.oneTimeProducts;
    return {
      tipo: kind,
      produtos: (Array.isArray(list) ? list : []).map((p: any) => productSummary(kind, p)),
      proximo_token: data.nextPageToken,
    };
  },

  async ler_produto(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const kind = v.productKind(args.tipo);
    return ctx.api.call(requests.getProduct(pkg, kind, v.productId(args.product_id)));
  },

  async salvar_produto(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const kind = v.productKind(args.tipo);
    const id = v.productId(args.product_id);
    const body = v.productBody(args.produto, pkg, id);
    const mask = v.optionalUpdateMask(args.campos);
    const regions = v.regionsVersion(args.versao_regioes);

    // Le o produto atual para saber se e criacao ou atualizacao e montar o resumo.
    let current: any = null;
    try {
      current = await ctx.api.call(requests.getProduct(pkg, kind, id));
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.status === 404)) throw e;
    }
    if (current && !mask) throw new ValidationError('o produto ja existe: informe campos (ex.: listings) com o que deve ser atualizado');

    // Na criacao o Google ignora o updateMask, mas o parametro e obrigatorio: mandamos os campos do corpo.
    const updateMask = mask ?? Object.keys(body).filter((k) => k !== 'packageName' && k !== 'productId').join(',');
    if (!updateMask) throw new ValidationError('produto sem campos para salvar');

    if (!v.isConfirmed(args.confirmar)) {
      const fields = updateMask.split(',');
      const top = [...new Set(fields.map((f) => f.split('.')[0]))];
      return {
        aplicado: false,
        operacao: current ? 'atualizar' : 'criar',
        product_id: id,
        campos: current ? fields : 'todos (criacao)',
        mudancas: current ? top.map((f) => ({ campo: f, antes: preview(current[f]), depois: preview(body[f]) })) : undefined,
        novo_produto: current ? undefined : productSummary(kind, body),
        versao_regioes: regions,
        proximo_passo: 'Chame de novo com confirmar=true para salvar.',
      };
    }

    const saved = await ctx.api.call(requests.patchProduct(pkg, kind, id, body, { updateMask, regionsVersion: regions }));
    return { aplicado: true, operacao: current ? 'atualizado' : 'criado', produto: productSummary(kind, saved) };
  },

  async mudar_estado_produto(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const kind = v.productKind(args.tipo);
    const id = v.productId(args.product_id);
    const option = v.optionId(args.opcao_id);
    const action = v.stateAction(args.acao);

    const product = await ctx.api.call<any>(requests.getProduct(pkg, kind, id));
    const options: any[] = kind === 'assinatura' ? product.basePlans ?? [] : product.purchaseOptions ?? [];
    const found = options.find((o) => (kind === 'assinatura' ? o.basePlanId : o.purchaseOptionId) === option);
    if (!found) throw new ValidationError(`${kind === 'assinatura' ? 'plano base' : 'opcao de compra'} ${option} nao existe no produto ${id}`);

    if (!v.isConfirmed(args.confirmar)) {
      return {
        aplicado: false,
        product_id: id,
        opcao_id: option,
        estado_atual: found.state,
        acao: action,
        proximo_passo: 'Chame de novo com confirmar=true para aplicar.',
      };
    }
    await ctx.api.call(requests.setOptionState(pkg, kind, id, option, action));
    return { aplicado: true, product_id: id, opcao_id: option, acao: action };
  },

  async atualizar_seguranca_dados(ctx, args) {
    const pkg = await requireApp(ctx, args.package_name);
    const { csv, lines, header } = v.dataSafetyCsv(args.csv);
    if (!v.isConfirmed(args.confirmar)) {
      return {
        aplicado: false,
        resumo: 'Vai SUBSTITUIR a declaracao de Seguranca dos dados inteira. A API nao permite ler a versao atual para comparar.',
        linhas: lines,
        cabecalho: header,
        proximo_passo: 'Chame de novo com confirmar=true para enviar.',
      };
    }
    await ctx.api.call(requests.dataSafety(pkg, csv));
    return { aplicado: true, linhas_enviadas: lines };
  },
};

// Executa a ferramenta e devolve o resultado no formato MCP (texto JSON ou erro claro).
export async function callTool(ctx: ToolContext, name: string, args: Args) {
  const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
  if (!handler) return { content: [{ type: 'text', text: `Ferramenta desconhecida: ${String(name).slice(0, 60)}` }], isError: true };
  try {
    const result = await handler(ctx, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const pkg = typeof args?.package_name === 'string' && /^[A-Za-z0-9_.]{1,150}$/.test(args.package_name) ? args.package_name : undefined;
    return { content: [{ type: 'text', text: friendlyError(e, pkg) }], isError: true };
  }
}
