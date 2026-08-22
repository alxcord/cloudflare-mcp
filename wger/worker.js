// MCP Worker - leitura e escrita real na API do Wger (wger.de) via Cloudflare Workers
// Arquivo unico, sem build/npm.
//
// Secrets necessarios (aba Settings > Variables and Secrets do Worker):
//   WGER_TOKEN  - Permanent Token da API do Wger (gerado nas configuracoes do usuario, secao "API key")
//   MCP_SECRET  - string aleatoria usada como segmento da URL
//
// Rota esperada: https://mcp-wger.alexcordeiro.dev/<MCP_SECRET>/mcp
//
// Diferente do mcp-git (que tem ferramentas dedicadas por operacao), este Worker expoe um
// pequeno conjunto de ferramentas GENERICAS que conversam com qualquer endpoint da API v2 do
// Wger (https://wger.de/api/v2/<recurso>/). Isso evita fixar no codigo suposicoes sobre nomes
// exatos de campos de cada recurso (peso, rotina, nutricao, etc.) que podem mudar entre versoes
// da API - quem decide o endpoint e o corpo da chamada e o Claude, olhando a documentacao/schema
// da API quando precisar.

const WGER_API = 'https://wger.de/api/v2';

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const TOOLS = [
  {
    name: 'whoami',
    description: 'Retorna o perfil do usuario do Wger autenticado pelo token configurado.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'api_get',
    description: 'Faz um GET generico num endpoint da API v2 do Wger (ex: path="weightentry", path="routine", path="exercise/search"). Use para listar ou consultar qualquer recurso.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do recurso, sem barras nas pontas. Ex: "weightentry", "routine/123", "exercise/search"' },
        query: { type: 'object', description: 'Parametros de query string, ex: {"limit": "10", "term": "supino"}' }
      },
      required: ['path']
    }
  },
  {
    name: 'api_post',
    description: 'Cria um novo registro num endpoint da API v2 do Wger (ex: registrar peso, criar sessao de treino, criar entrada no diario nutricional).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do recurso, sem barras nas pontas. Ex: "weightentry", "nutritiondiary"' },
        body: { type: 'object', description: 'Corpo JSON do novo registro, campos dependem do recurso' }
      },
      required: ['path', 'body']
    }
  },
  {
    name: 'api_patch',
    description: 'Atualiza parcialmente um registro existente na API v2 do Wger, dado o id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Nome do recurso, sem id. Ex: "weightentry"' },
        id: { type: 'string', description: 'Id do registro a atualizar' },
        body: { type: 'object', description: 'Campos a atualizar' }
      },
      required: ['path', 'id', 'body']
    }
  },
  {
    name: 'api_delete',
    description: 'Apaga um registro existente na API v2 do Wger, dado o id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Nome do recurso, sem id. Ex: "weightentry"' },
        id: { type: 'string', description: 'Id do registro a apagar' }
      },
      required: ['path', 'id']
    }
  }
];

function buildUrl(path, query) {
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  const url = new URL(`${WGER_API}/${cleanPath}/`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function wger(env, path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : buildUrl(path, opts.query), {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Token ${env.WGER_TOKEN}`,
      'Accept': 'application/json',
      'User-Agent': 'alexcordeiro-mcp-worker',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail || JSON.stringify(data))) || `Wger API error ${res.status}`;
    throw new Error(`${res.status} ${msg}`);
  }
  return data;
}

async function toolWhoami(env) {
  const data = await wger(env, 'userprofile');
  return data;
}

async function toolApiGet(env, args) {
  const { path, query } = args;
  return wger(env, path, { method: 'GET', query });
}

async function toolApiPost(env, args) {
  const { path, body } = args;
  return wger(env, path, { method: 'POST', body });
}

async function toolApiPatch(env, args) {
  const { path, id, body } = args;
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  return wger(env, `${cleanPath}/${id}`, { method: 'PATCH', body });
}

async function toolApiDelete(env, args) {
  const { path, id } = args;
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  return wger(env, `${cleanPath}/${id}`, { method: 'DELETE' });
}

async function callTool(env, name, args) {
  switch (name) {
    case 'whoami': return toolWhoami(env);
    case 'api_get': return toolApiGet(env, args);
    case 'api_post': return toolApiPost(env, args);
    case 'api_patch': return toolApiPatch(env, args);
    case 'api_delete': return toolApiDelete(env, args);
    default: throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

async function handleRpc(env, body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'alexcordeiro-wger-mcp', version: '1.0.0' }
    });
  }

  if (method === 'notifications/initialized') {
    return null; // notificacao, sem resposta
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = await callTool(env, name, args || {});
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      });
    } catch (e) {
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // [secret, 'mcp']

    if (parts.length !== 2 || parts[1] !== 'mcp') {
      return new Response('Not found', { status: 404 });
    }
    const [secret] = parts;
    if (!env.MCP_SECRET || secret !== env.MCP_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const isBatch = Array.isArray(body);
    const messages = isBatch ? body : [body];

    const results = [];
    for (const msg of messages) {
      const result = await handleRpc(env, msg);
      if (result) results.push(result);
    }

    if (results.length === 0) {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify(isBatch ? results : results[0]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
