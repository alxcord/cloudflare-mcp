// Validacao e limpeza de toda entrada vinda das ferramentas MCP.
//
// Regra geral: cada valor passa por uma allowlist de formato antes de entrar numa URL ou num
// corpo. Valores invalidos geram ValidationError com mensagem clara (sem ecoar o valor inteiro).

export class ValidationError extends Error {}

// Limite de caracteres da resposta a avaliacao (documentado pelo Google: ~350).
export const MAX_REPLY_CHARS = 350;
// Tamanho maximo aceito para o JSON de um produto e para o CSV de Seguranca dos dados.
export const MAX_PRODUCT_JSON_BYTES = 64 * 1024;
export const MAX_DATA_SAFETY_CSV_BYTES = 256 * 1024;
// Versao das regioes de preco usada por padrao nas escritas de produto.
export const DEFAULT_REGIONS_VERSION = '2022/02';

// Package name Android: segmentos separados por ponto, cada um comecando por letra.
// Sem barra, sem "%", sem "?" ou "#": nada que mude o caminho da URL.
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function packageName(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('package_name e obrigatorio');
  const v = value.trim();
  if (v.length > 150 || !PACKAGE_RE.test(v)) throw new ValidationError('package_name invalido: use o formato com.exemplo.app');
  return v;
}

// Lista de package names do secret PLAY_PACKAGES, separados por virgula ou espaco.
// Itens invalidos sao ignorados (o valor nao vai para log nem para mensagem).
export function packageList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const valid: string[] = [];
  for (const item of value.split(/[\s,]+/)) {
    try {
      const pkg = packageName(item);
      if (!valid.includes(pkg)) valid.push(pkg);
    } catch {
      // item invalido: ignorado
    }
  }
  return valid.slice(0, 100);
}

// E-mail simples (usuario@dominio.tld). Usado para grupos de testadores.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/;

export function email(value: unknown, field = 'email'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} precisa ser texto`);
  const v = value.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) throw new ValidationError(`${field} invalido: ${v.slice(0, 80)}`);
  return v;
}

export function emailList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} precisa ser uma lista de e-mails`);
  if (value.length > 50) throw new ValidationError(`${field} aceita no maximo 50 itens por chamada`);
  // Remove duplicados mantendo a ordem.
  return [...new Set(value.map((v) => email(v, field)))];
}

// Faixas de teste: internal, alpha (fechada), beta (aberta) ou faixas fechadas personalizadas.
// Producao e recusada: testadores nao se aplicam a ela e este MCP nao mexe em producao.
const TRACK_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,99}$/;

export function testTrack(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('faixa e obrigatoria');
  const v = value.trim();
  if (!TRACK_RE.test(v)) throw new ValidationError('faixa invalida: use internal, alpha, beta ou o nome da faixa fechada');
  if (v === 'production' || v.endsWith(':production')) throw new ValidationError('a faixa de producao nao tem testadores e esta fora do escopo deste MCP');
  return v;
}

// ID de avaliacao do Google (ex.: "gp:AOqpTO..."): letras, numeros, ":", "-", "_" e ".".
const REVIEW_ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

export function reviewId(value: unknown): string {
  if (typeof value !== 'string' || !REVIEW_ID_RE.test(value.trim())) throw new ValidationError('review_id invalido');
  return value.trim();
}

// Idioma de traducao opcional: "pt", "en", "pt_BR", "en-GB".
const LANG_RE = /^[a-z]{2,3}([_-][A-Za-z]{2})?$/;

export function optionalLanguage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !LANG_RE.test(value)) throw new ValidationError('idioma_traducao invalido: use algo como pt, en ou pt_BR');
  return value;
}

// Token de paginacao devolvido pelo Google: so caracteres seguros para query string.
const PAGE_TOKEN_RE = /^[A-Za-z0-9_\-=.~+/]{1,2000}$/;

export function optionalPageToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !PAGE_TOKEN_RE.test(value)) throw new ValidationError('token de pagina invalido');
  return value;
}

export function intInRange(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${field} precisa ser inteiro entre ${min} e ${max}`);
  return n;
}

// Texto da resposta a avaliacao: remove caracteres de controle (exceto quebra de linha),
// recusa HTML (o Google removeria as tags sem avisar) e confere o limite de 350 caracteres.
export function replyText(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('texto e obrigatorio');
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .trim();
  if (!cleaned) throw new ValidationError('texto nao pode ficar vazio');
  if (/<[^>]*>/.test(cleaned)) throw new ValidationError('texto nao pode ter tags HTML: o Google remove as tags');
  const length = [...cleaned].length; // conta caracteres, nao unidades UTF-16 (emoji conta 1)
  if (length > MAX_REPLY_CHARS) throw new ValidationError(`texto tem ${length} caracteres. O limite do Google e ${MAX_REPLY_CHARS}`);
  return cleaned;
}

// Tipo de produto aceito nas ferramentas de produtos.
export type ProductKind = 'unico' | 'assinatura';

export function productKind(value: unknown): ProductKind {
  if (value === 'unico' || value === 'assinatura') return value;
  throw new ValidationError('tipo precisa ser "unico" (produto de compra unica) ou "assinatura"');
}

// ID de produto: comeca por numero ou letra minuscula, depois minusculas, numeros, "_" e ".".
const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9_.]{0,139}$/;

export function productId(value: unknown): string {
  if (typeof value !== 'string' || !PRODUCT_ID_RE.test(value.trim())) {
    throw new ValidationError('product_id invalido: minusculas, numeros, "_" e ".", comecando por letra ou numero');
  }
  return value.trim();
}

// ID de plano base (assinatura) ou de opcao de compra (produto unico): minusculas, numeros e "-".
const OPTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function optionId(value: unknown): string {
  if (typeof value !== 'string' || !OPTION_ID_RE.test(value.trim())) {
    throw new ValidationError('opcao_id invalido: minusculas, numeros e "-", ate 63 caracteres');
  }
  return value.trim();
}

export function stateAction(value: unknown): 'ativar' | 'desativar' {
  if (value === 'ativar' || value === 'desativar') return value;
  throw new ValidationError('acao precisa ser "ativar" ou "desativar"');
}

// updateMask: lista de campos separados por virgula (ex.: "listings,purchaseOptions").
const MASK_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*(,[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*)*$/;

export function optionalUpdateMask(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = Array.isArray(value) ? value.join(',') : value;
  if (typeof v !== 'string' || v.length > 500 || !MASK_RE.test(v.replace(/\s+/g, ''))) {
    throw new ValidationError('campos invalido: lista de nomes de campos separados por virgula, ex.: listings,purchaseOptions');
  }
  return v.replace(/\s+/g, '');
}

// Versao das regioes de preco, ex.: "2022/02".
export function regionsVersion(value: unknown): string {
  if (value === undefined || value === null || value === '') return DEFAULT_REGIONS_VERSION;
  if (typeof value !== 'string' || !/^\d{4}\/\d{2}$/.test(value)) throw new ValidationError('versao_regioes invalida: use o formato AAAA/MM, ex.: 2022/02');
  return value;
}

// Corpo de produto: objeto JSON simples, com tamanho limitado. packageName e productId do corpo
// sao sobrescritos pelos parametros validados, para o corpo nao apontar para outro app.
export function productBody(value: unknown, pkg: string, id: string): Record<string, unknown> {
  let obj: unknown = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      throw new ValidationError('produto precisa ser um objeto JSON valido');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ValidationError('produto precisa ser um objeto JSON');
  const size = new TextEncoder().encode(JSON.stringify(obj)).length;
  if (size > MAX_PRODUCT_JSON_BYTES) throw new ValidationError(`produto tem ${size} bytes. O limite e ${MAX_PRODUCT_JSON_BYTES}`);
  return { ...(obj as Record<string, unknown>), packageName: pkg, productId: id };
}

// CSV da declaracao de Seguranca dos dados (modelo exportado do Play Console).
export function dataSafetyCsv(value: unknown): { csv: string; lines: number; header: string } {
  if (typeof value !== 'string') throw new ValidationError('csv e obrigatorio');
  const csv = value.replace(/\r\n?/g, '\n').replace(/^﻿/, '').trim();
  if (!csv) throw new ValidationError('csv nao pode ficar vazio');
  const size = new TextEncoder().encode(csv).length;
  if (size > MAX_DATA_SAFETY_CSV_BYTES) throw new ValidationError(`csv tem ${size} bytes. O limite aceito e ${MAX_DATA_SAFETY_CSV_BYTES}`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(csv)) throw new ValidationError('csv tem caracteres de controle invalidos');
  const rows = csv.split('\n');
  if (rows.length < 2 || !rows[0].includes(',')) throw new ValidationError('csv precisa ter cabecalho e ao menos uma linha, separados por virgula');
  return { csv, lines: rows.length, header: rows[0].slice(0, 200) };
}

// Confirmacao explicita: so o booleano true (ou a string "true") libera a escrita.
export function isConfirmed(value: unknown): boolean {
  return value === true || value === 'true';
}
