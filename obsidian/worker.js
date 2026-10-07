// MCP Worker — busca nas notas dos vaults Obsidian com Cloudflare D1 (FTS5)
// Arquivo único, sem build/npm.
//
// Secrets necessários (Settings > Variables and Secrets do Worker):
//   MCP_SECRET  — chave de assinatura dos JWTs OAuth + senha da tela de aprovação
//   API_TOKEN   — Bearer token estático para a API do indexador (/api/*)
//
// D1 binding (wrangler.toml + Settings > Bindings do Worker):
//   DB          — banco criado com: wrangler d1 create obsidian-index
//                 Copiar o database_id retornado e colar em wrangler.toml antes do primeiro push.
//
// Após o primeiro deploy bem-sucedido, inicializar as tabelas uma única vez:
//   curl -X POST https://mcp-obsidian.<seu-dominio>/api/init \
//     -H "Authorization: Bearer <API_TOKEN>"
//
// Rotas OAuth (para o Claude via custom connector MCP):
//   GET  /.well-known/oauth-authorization-server  — metadata OAuth
//   GET  /authorize                                — tela de aprovação
//   POST /token                                    — troca code por access_token
//   POST /mcp                                      — endpoint MCP (Bearer JWT)
//
// Rotas REST (usadas pelo indexador, auth: Bearer <API_TOKEN>):
//   POST /api/init                  — cria tabelas (idempotente, rodar uma vez)
//   GET  /api/manifest?vault=       — caminho -> hash das notas já indexadas
//   POST /api/ingest                — grava um lote de notas ({vault, notes: [...]})
//   POST /api/delete                — remove notas ({vault, paths: [...]})
//
// Todas as tabelas têm a coluna `vault`, então vários vaults convivem no mesmo banco.

const AUTH_CODE_TTL = 60;
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30;

// ── Esquema do banco ─────────────────────────────────────────────────────────
// Toda tabela tem a coluna vault. notes_fts usa o rowid de notes, então apagar e
// atualizar é por chave (barato) e não por varredura.
const INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS notes (
     vault TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, folder TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, sha TEXT NOT NULL DEFAULT '',
     indexed_at TEXT NOT NULL, PRIMARY KEY (vault, path))`,
  `CREATE TABLE IF NOT EXISTS note_tags (
     vault TEXT NOT NULL, tag TEXT NOT NULL, path TEXT NOT NULL,
     PRIMARY KEY (vault, tag, path)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_note_tags_path ON note_tags (vault, path)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
     title, tags, body, tokenize = 'unicode61 remove_diacritics 2')`
];

let esquemaPronto = null;
function garantirEsquema(DB) {
  // Roda uma vez por instância do Worker.
  if (!esquemaPronto) {
    esquemaPronto = DB.batch(INIT_SQL.map(sql => DB.prepare(sql))).catch(e => {
      esquemaPronto = null;
      throw e;
    });
  }
  return esquemaPronto;
}

// ── Utilidades ───────────────────────────────────────────────────────────────
function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra }
  });
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Minúsculas e sem acento, igual ao que o indexador grava em note_tags.
function normalizaTag(tag) {
  return String(tag)
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-');
}

// Transforma o texto digitado em uma consulta FTS5 segura.
// Palavras viram prefixos ("data"* encontra "databricks"); frases entre aspas ficam exatas.
function montaConsultaFts(texto) {
  const termos = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(texto)))) {
    if (m[1]) {
      termos.push('"' + m[1].replace(/"/g, '""') + '"');
    } else {
      for (const parte of m[2].split(/[^\p{L}\p{N}_]+/u).filter(Boolean)) {
        termos.push('"' + parte + '"*');
      }
    }
  }
  return termos.join(' ');
}

function somaLinhasEscritas(resultados) {
  return resultados.reduce((total, r) => total + (r.meta?.rows_written || 0), 0);
}

function idVaultValido(vault) {
  return typeof vault === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(vault);
}

// ── API do indexador ─────────────────────────────────────────────────────────
function exigeApiToken(env, request) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  const enviado = m ? m[1] : '';
  const esperado = env.API_TOKEN || '';
  // Comparação em tempo constante.
  let diferenca = enviado.length ^ esperado.length;
  for (let i = 0; i < esperado.length; i++) {
    diferenca |= (enviado.charCodeAt(i) || 0) ^ esperado.charCodeAt(i);
  }
  if (!esperado || diferenca !== 0) throw new Error('unauthorized');
}

async function handleApi(env, request, url) {
  try {
    exigeApiToken(env, request);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  await garantirEsquema(env.DB);
  const rota = url.pathname.replace(/^\/api/, '');

  // POST /api/init: cria as tabelas (idempotente)
  if (rota === '/init' && request.method === 'POST') {
    await garantirEsquema(env.DB);
    return jsonResponse({ ok: true, message: 'Tabelas criadas (ou já existiam)' });
  }

  // Lista caminho -> hash do que já está indexado, para o indexador enviar só o que mudou.
  if (rota === '/manifest' && request.method === 'GET') {
    const vault = url.searchParams.get('vault');
    if (!idVaultValido(vault)) return jsonResponse({ error: 'vault inválido' }, 400);
    const { results } = await env.DB.prepare('SELECT path, sha FROM notes WHERE vault = ?').bind(vault).all();
    return jsonResponse({ notes: Object.fromEntries(results.map(r => [r.path, r.sha])) });
  }

  // Grava (ou regrava) um lote de notas.
  if (rota === '/ingest' && request.method === 'POST') {
    const corpo = await request.json().catch(() => null);
    if (!corpo || !idVaultValido(corpo.vault) || !Array.isArray(corpo.notes)) {
      return jsonResponse({ error: 'corpo inválido' }, 400);
    }
    const agora = new Date().toISOString();
    const comandos = [];
    for (const n of corpo.notes) {
      if (!n || typeof n.path !== 'string' || typeof n.title !== 'string' || typeof n.body !== 'string') {
        return jsonResponse({ error: 'nota inválida' }, 400);
      }
      const vault = corpo.vault;
      const tags = Array.isArray(n.tags) ? n.tags.map(String) : [];
      // 1. Remove a linha antiga do índice de texto (se a nota já existia).
      comandos.push(
        env.DB.prepare(
          'DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE vault = ?1 AND path = ?2)'
        ).bind(vault, n.path)
      );
      // 2. Insere ou atualiza os metadados. A atualização mantém o rowid.
      comandos.push(
        env.DB.prepare(
          `INSERT INTO notes (vault, path, title, folder, tags, size, sha, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (vault, path) DO UPDATE SET
           title = excluded.title, folder = excluded.folder, tags = excluded.tags,
           size = excluded.size, sha = excluded.sha, indexed_at = excluded.indexed_at`
        ).bind(vault, n.path, n.title, n.folder || '', tags.join(' '), n.size || 0, n.sha || '', agora)
      );
      // 3. Insere o texto no índice de busca usando o rowid da nota.
      comandos.push(
        env.DB.prepare(
          `INSERT INTO notes_fts (rowid, title, tags, body)
         VALUES ((SELECT rowid FROM notes WHERE vault = ?1 AND path = ?2), ?3, ?4, ?5)`
        ).bind(vault, n.path, n.title, tags.join(' '), n.body)
      );
      // 4. Troca as tags da nota.
      comandos.push(
        env.DB.prepare('DELETE FROM note_tags WHERE vault = ?1 AND path = ?2').bind(vault, n.path)
      );
      if (tags.length) {
        comandos.push(
          env.DB.prepare(
            'INSERT OR IGNORE INTO note_tags (vault, tag, path) SELECT ?1, value, ?2 FROM json_each(?3)'
          ).bind(vault, n.path, JSON.stringify(tags))
        );
      }
    }
    const resultados = await env.DB.batch(comandos);
    return jsonResponse({
      ok: true,
      notes: corpo.notes.length,
      rows_written: somaLinhasEscritas(resultados)
    });
  }

  // Remove notas que não existem mais no vault.
  if (rota === '/delete' && request.method === 'POST') {
    const corpo = await request.json().catch(() => null);
    if (!corpo || !idVaultValido(corpo.vault) || !Array.isArray(corpo.paths)) {
      return jsonResponse({ error: 'corpo inválido' }, 400);
    }
    const comandos = [];
    for (const path of corpo.paths) {
      comandos.push(
        env.DB.prepare(
          'DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE vault = ?1 AND path = ?2)'
        ).bind(corpo.vault, path)
      );
      comandos.push(
        env.DB.prepare('DELETE FROM note_tags WHERE vault = ?1 AND path = ?2').bind(corpo.vault, path)
      );
      comandos.push(
        env.DB.prepare('DELETE FROM notes WHERE vault = ?1 AND path = ?2').bind(corpo.vault, path)
      );
    }
    const resultados = comandos.length ? await env.DB.batch(comandos) : [];
    return jsonResponse({
      ok: true,
      deleted: corpo.paths.length,
      rows_written: somaLinhasEscritas(resultados)
    });
  }

  return jsonResponse({ error: 'rota não encontrada' }, 404);
}

// ── Ferramentas MCP ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'buscar_notas',
    description:
      'Busca texto nas notas dos vaults Obsidian indexados (título, tags e conteúdo, sem imagens). ' +
      'Palavras casam por prefixo e todas precisam aparecer; use aspas para frase exata. ' +
      'Pode filtrar por vault, pasta e tags. Devolve caminho, título, tags e um trecho com o termo entre « ». ' +
      'Para ler a nota inteira use ler_nota.',
    inputSchema: {
      type: 'object',
      properties: {
        consulta: {
          type: 'string',
          description: 'Texto a buscar, ex.: databricks unity catalog ou "control-m"'
        },
        vault: { type: 'string', description: 'Id do vault (ver listar_vaults). Omitido = todos' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Só notas que tenham todas estas tags'
        },
        pasta: {
          type: 'string',
          description: 'Só notas cuja pasta comece com este prefixo, ex.: 02-Areas/05-Reunioes'
        },
        limite: { type: 'number', description: 'Máximo de resultados (padrão 10, máximo 30)' }
      },
      required: ['consulta']
    }
  },
  {
    name: 'buscar_por_tag',
    description:
      'Lista notas que tenham todas as tags informadas, sem busca de texto. ' +
      "Tags são comparadas sem acento e sem diferença de maiúsculas; 'a/b' também conta como 'a'.",
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Uma ou mais tags' },
        vault: { type: 'string', description: 'Id do vault. Omitido = todos' },
        pasta: { type: 'string', description: 'Prefixo de pasta' },
        limite: { type: 'number', description: 'Máximo de resultados (padrão 50, máximo 200)' }
      },
      required: ['tags']
    }
  },
  {
    name: 'listar_tags',
    description:
      'Lista as tags existentes com a quantidade de notas de cada uma, da mais usada para a menos usada.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Id do vault. Omitido = todos' },
        prefixo: { type: 'string', description: 'Só tags que comecem com este texto' },
        limite: { type: 'number', description: 'Máximo de tags (padrão 100, máximo 500)' }
      }
    }
  },
  {
    name: 'ler_nota',
    description:
      'Devolve o texto indexado de uma nota (sem imagens). Informe o caminho exato (de buscar_notas) ' +
      'ou o título. Notas longas vêm em partes: use deslocamento para continuar.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: 'Id do vault. Obrigatório com caminho; opcional com título' },
        caminho: { type: 'string', description: 'Caminho da nota dentro do vault' },
        titulo: { type: 'string', description: 'Título (nome do arquivo sem .md), se não souber o caminho' },
        deslocamento: { type: 'number', description: 'Posição inicial em caracteres (padrão 0)' },
        max_caracteres: { type: 'number', description: 'Tamanho da parte (padrão 30000, máximo 100000)' }
      }
    }
  },
  {
    name: 'listar_vaults',
    description: 'Lista os vaults indexados, com quantidade de notas e data da última indexação.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// Monta o filtro comum (vault, pasta e tags) sobre a tabela notes (alias n).
function filtrosComuns({ vault, pasta, tags }, binds) {
  const partes = [];
  if (vault) {
    partes.push('n.vault = ?');
    binds.push(vault);
  }
  if (pasta) {
    // Prefixo de pasta, escapando os curingas do LIKE.
    partes.push("n.folder LIKE ? ESCAPE '\\'");
    binds.push(String(pasta).replace(/[\\%_]/g, '\\$&') + '%');
  }
  for (const tag of tags || []) {
    partes.push(
      'EXISTS (SELECT 1 FROM note_tags t WHERE t.vault = n.vault AND t.path = n.path AND t.tag = ?)'
    );
    binds.push(normalizaTag(tag));
  }
  return partes;
}

async function buscarNotas(DB, { consulta, vault, tags, pasta, limite }) {
  const fts = montaConsultaFts(consulta);
  if (!fts) throw new Error('consulta vazia');
  const binds = [fts];
  const filtros = filtrosComuns({ vault, pasta, tags }, binds);
  binds.push(Math.min(Number(limite) || 10, 30));
  const sql = `
    SELECT n.vault, n.path, n.title, n.folder, n.tags,
           snippet(notes_fts, 2, '«', '»', '…', 28) AS trecho
    FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? ${filtros.map(f => 'AND ' + f).join(' ')}
    ORDER BY bm25(notes_fts, 8.0, 4.0, 1.0)
    LIMIT ?`;
  const { results } = await DB.prepare(sql)
    .bind(...binds)
    .all();
  return { total: results.length, resultados: results };
}

async function buscarPorTag(DB, { tags, vault, pasta, limite }) {
  const lista = [...new Set((tags || []).map(normalizaTag).filter(Boolean))];
  if (!lista.length) throw new Error('informe ao menos uma tag');
  const binds = [...lista];
  const filtros = filtrosComuns({ vault, pasta }, binds);
  binds.push(lista.length, Math.min(Number(limite) || 50, 200));
  const sql = `
    SELECT n.vault, n.path, n.title, n.folder, n.tags
    FROM note_tags t JOIN notes n ON n.vault = t.vault AND n.path = t.path
    WHERE t.tag IN (${lista.map(() => '?').join(',')}) ${filtros.map(f => 'AND ' + f).join(' ')}
    GROUP BY n.vault, n.path
    HAVING COUNT(DISTINCT t.tag) = ?
    ORDER BY n.path
    LIMIT ?`;
  const { results } = await DB.prepare(sql)
    .bind(...binds)
    .all();
  return { total: results.length, resultados: results };
}

async function listarTags(DB, { vault, prefixo, limite }) {
  const binds = [];
  const filtros = [];
  if (vault) {
    filtros.push('vault = ?');
    binds.push(vault);
  }
  if (prefixo) {
    filtros.push("tag LIKE ? ESCAPE '\\'");
    binds.push(normalizaTag(prefixo).replace(/[\\%_]/g, '\\$&') + '%');
  }
  binds.push(Math.min(Number(limite) || 100, 500));
  const sql = `SELECT tag, COUNT(*) AS notas FROM note_tags
               ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
               GROUP BY tag ORDER BY notas DESC, tag LIMIT ?`;
  const { results } = await DB.prepare(sql)
    .bind(...binds)
    .all();
  return { total: results.length, tags: results };
}

async function lerNota(DB, { vault, caminho, titulo, deslocamento, max_caracteres }) {
  let nota;
  if (caminho) {
    if (!vault) throw new Error('informe o vault junto com o caminho');
    nota = await DB.prepare(
      `SELECT n.vault, n.path, n.title, n.folder, n.tags, n.indexed_at, f.body
       FROM notes n JOIN notes_fts f ON f.rowid = n.rowid WHERE n.vault = ? AND n.path = ?`
    )
      .bind(vault, caminho)
      .first();
  } else if (titulo) {
    const binds = [titulo];
    if (vault) binds.push(vault);
    const { results } = await DB.prepare(
      `SELECT n.vault, n.path, n.title, n.folder, n.tags, n.indexed_at, f.body
       FROM notes n JOIN notes_fts f ON f.rowid = n.rowid
       WHERE n.title = ? COLLATE NOCASE ${vault ? 'AND n.vault = ?' : ''} LIMIT 10`
    )
      .bind(...binds)
      .all();
    if (results.length > 1) {
      return {
        aviso: 'mais de uma nota com esse título, use caminho',
        opcoes: results.map(r => ({ vault: r.vault, path: r.path }))
      };
    }
    nota = results[0];
  } else {
    throw new Error('informe caminho ou titulo');
  }
  if (!nota) throw new Error('nota não encontrada');

  const inicio = Math.max(Number(deslocamento) || 0, 0);
  const tamanho = Math.min(Number(max_caracteres) || 30000, 100000);
  const trecho = nota.body.slice(inicio, inicio + tamanho);
  const fim = inicio + trecho.length;
  return {
    vault: nota.vault,
    path: nota.path,
    title: nota.title,
    folder: nota.folder,
    tags: nota.tags,
    indexed_at: nota.indexed_at,
    total_caracteres: nota.body.length,
    deslocamento: inicio,
    proximo_deslocamento: fim < nota.body.length ? fim : null,
    texto: trecho
  };
}

async function listarVaults(DB) {
  const { results } = await DB.prepare(
    'SELECT vault, COUNT(*) AS notas, MAX(indexed_at) AS ultima_indexacao FROM notes GROUP BY vault ORDER BY vault'
  ).all();
  return { vaults: results };
}

async function chamaFerramenta(DB, nome, args) {
  await garantirEsquema(DB);
  switch (nome) {
    case 'buscar_notas':
      return buscarNotas(DB, args);
    case 'buscar_por_tag':
      return buscarPorTag(DB, args);
    case 'listar_tags':
      return listarTags(DB, args);
    case 'ler_nota':
      return lerNota(DB, args);
    case 'listar_vaults':
      return listarVaults(DB);
    default:
      throw new Error('ferramenta desconhecida: ' + nome);
  }
}

async function handleRpc(env, body) {
  const { id, method, params } = body;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alexcordeiro-obsidian-mcp', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return jsonRpcResult(id, {});
  if (method === 'tools/list') return jsonRpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const resultado = await chamaFerramenta(env.DB, name, args || {});
      return jsonRpcResult(id, { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }] });
    } catch (e) {
      return jsonRpcResult(id, { content: [{ type: 'text', text: 'Erro: ' + e.message }], isError: true });
    }
  }
  return jsonRpcError(id, -32601, 'Method not found: ' + method);
}

// ── OAuth 2.1 + PKCE ─────────────────────────────────────────────────────────
function b64urlEncode(bytes) {
  let binario = '';
  bytes.forEach(b => (binario += String.fromCharCode(b)));
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncodeStr(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}

function b64urlDecodeToBytes(b64url) {
  const b64 = b64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const binario = atob(b64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signJWT(payload, secret) {
  const h = b64urlEncodeStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64urlEncodeStr(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyJWT(token, secret) {
  const partes = String(token).split('.');
  if (partes.length !== 3) throw new Error('JWT malformado');
  const [h, p, sig] = partes;
  const key = await hmacKey(secret);
  const valido = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecodeToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valido) throw new Error('Assinatura inválida');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(p)));
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) throw new Error('Token expirado');
  return payload;
}

async function sha256B64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64urlEncode(new Uint8Array(digest));
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapaHtml(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formularioAprovar(params, erro) {
  const ocultos = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapaHtml(k)}" value="${escapaHtml(v)}">`)
    .join('\n    ');
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar acesso</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; color: #111; }
  h1 { font-size: 18px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 16px; margin: 12px 0; box-sizing: border-box; }
  button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
  .err { color: #b00020; font-size: 14px; }
</style></head>
<body>
  <h1>Autorizar acesso ao MCP Obsidian</h1>
  <p>Cole o segredo (MCP_SECRET) para aprovar esta conexão.</p>
  ${erro ? `<p class="err">${escapaHtml(erro)}</p>` : ''}
  <form method="GET" action="/authorize">
    ${ocultos}
    <input type="password" name="key" placeholder="MCP_SECRET" autofocus required>
    <button type="submit">Aprovar</button>
  </form>
</body></html>`;
}

async function handleAuthorize(env, url) {
  const p = url.searchParams;
  const redirect_uri = p.get('redirect_uri');
  const code_challenge = p.get('code_challenge');
  const code_challenge_method = p.get('code_challenge_method') || 'S256';
  const response_type = p.get('response_type') || 'code';
  const client_id = p.get('client_id') || '';
  const state = p.get('state') || '';
  const key = p.get('key');

  if (!redirect_uri || response_type !== 'code' || !code_challenge || code_challenge_method !== 'S256') {
    return htmlResponse('Requisição OAuth inválida.', 400);
  }
  const parametros = { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type };
  if (key === null) return htmlResponse(formularioAprovar(parametros));
  if (!env.MCP_SECRET || key !== env.MCP_SECRET) {
    await new Promise(r => setTimeout(r, 2000));
    return htmlResponse(formularioAprovar(parametros, 'Segredo incorreto. Tente de novo.'), 401);
  }
  const agora = Math.floor(Date.now() / 1000);
  const code = await signJWT(
    {
      iss: url.origin,
      aud: client_id,
      redirect_uri,
      code_challenge,
      typ: 'auth_code',
      iat: agora,
      exp: agora + AUTH_CODE_TTL
    },
    env.MCP_SECRET
  );
  const destino = new URL(redirect_uri);
  destino.searchParams.set('code', code);
  if (state) destino.searchParams.set('state', state);
  return Response.redirect(destino.toString(), 302);
}

async function handleToken(env, request) {
  const tipo = request.headers.get('Content-Type') || '';
  const params = tipo.includes('application/json')
    ? await request.json()
    : Object.fromEntries((await request.formData()).entries());
  const { grant_type, code, redirect_uri, code_verifier, client_id } = params;
  if (grant_type !== 'authorization_code') return jsonResponse({ error: 'unsupported_grant_type' }, 400);
  if (!code || !redirect_uri || !code_verifier) return jsonResponse({ error: 'invalid_request' }, 400);

  let payload;
  try {
    payload = await verifyJWT(code, env.MCP_SECRET);
  } catch (e) {
    return jsonResponse({ error: 'invalid_grant', error_description: e.message }, 400);
  }
  if (payload.typ !== 'auth_code' || payload.redirect_uri !== redirect_uri) {
    return jsonResponse({ error: 'invalid_grant' }, 400);
  }
  if ((await sha256B64url(code_verifier)) !== payload.code_challenge) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE code_verifier não confere' }, 400);
  }
  const agora = Math.floor(Date.now() / 1000);
  const accessToken = await signJWT(
    {
      iss: new URL(request.url).origin,
      aud: client_id || payload.aud,
      sub: 'user',
      typ: 'access_token',
      iat: agora,
      exp: agora + ACCESS_TOKEN_TTL
    },
    env.MCP_SECRET
  );
  return jsonResponse({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL });
}

async function exigeBearerJWT(env, request) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('missing bearer token');
  const payload = await verifyJWT(m[1], env.MCP_SECRET);
  if (payload.typ !== 'access_token') throw new Error('token type inválido');
  return payload;
}

// ── Router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const issuer = url.origin;

    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return jsonResponse({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    }
    if (url.pathname === '/authorize' && request.method === 'GET') return handleAuthorize(env, url);
    if (url.pathname === '/token' && request.method === 'POST') return handleToken(env, request);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(env, request, url);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try {
        await exigeBearerJWT(env, request);
      } catch (e) {
        return jsonResponse({ error: 'invalid_token', error_description: e.message }, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-authorization-server"`
        });
      }
      let corpo;
      try {
        corpo = await request.json();
      } catch {
        return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), 400);
      }
      const emLote = Array.isArray(corpo);
      const respostas = [];
      for (const msg of emLote ? corpo : [corpo]) {
        const r = await handleRpc(env, msg);
        if (r) respostas.push(r);
      }
      if (respostas.length === 0) return new Response(null, { status: 204 });
      return jsonResponse(emLote ? respostas : respostas[0]);
    }

    return new Response('Not found', { status: 404 });
  }
};
