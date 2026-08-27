// comm — hub de comunicacao multicanal (hoje: Telegram; desenhado para crescer para outros
// canais, como um futuro modo via MCP ou via web). Arquivo unico, sem build/npm.
//
// Secrets necessarios (Settings > Variables and Secrets do Worker):
//   TELEGRAM_BOT_TOKEN      - token do bot, gerado via @BotFather no Telegram.
//   TELEGRAM_WEBHOOK_SECRET - string aleatoria propria, usada para validar que os updates
//                             recebidos em /telegram/webhook vieram mesmo do Telegram (via
//                             cabecalho X-Telegram-Bot-Api-Secret-Token, configurado junto com
//                             o setWebhook).
//   ESP32_TOKEN             - string aleatoria propria, usada como Bearer token pelo
//                             dispositivo de monitoramento de rede local ao reportar status.
//
// KV necessario (Settings > Bindings > KV Namespace):
//   COMM_KV - usado para (a) lista de usuarios autorizados por canal e (b) o ultimo status
//             reportado pelo dispositivo de monitoramento, para o "dead man's switch".
//
// Rotas:
//   POST /telegram/webhook   recebe updates do Telegram (comandos)
//   POST /esp32/status       recebe relatorio periodico de status de um dispositivo de rede
//                            local (ex.: um microcontrolador fazendo ping em equipamentos)
//   (scheduled)              cron: verifica se o dispositivo de monitoramento parou de
//                            reportar (dead man's switch) e dispara alerta se sim
//
// Modelo de autorizacao: uma tabela simples em KV, chave "users:<chat_id>", valor
// { "nome": "...", "papel": "admin"|"leitura", "ativo": true }. So chat_ids presentes e ativos
// recebem resposta a comandos; os demais sao ignorados silenciosamente (sem revelar ao
// remetente se o bot existe ou nao).
//
// Modelo de comando: por enquanto roteamento fixo (se/senao por texto), no mesmo espirito dos
// outros Workers deste repo (dedicado primeiro, generico/IA depois). Um comando nao
// reconhecido cai num fallback central (handleFallback), ponto de extensao natural para
// futuramente delegar a interpretacao a um LLM.
//
// Este Worker NAO implementa o protocolo MCP (JSON-RPC) - e um webhook receptor HTTP simples.
// Mora no mesmo monorepo e segue o mesmo padrao de deploy dos demais Workers.

const TELEGRAM_API = 'https://api.telegram.org';
const DEAD_MAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos sem report = alerta

// ---------- KV helpers ----------

async function getUsuario(env, chatId) {
  const raw = await env.COMM_KV.get(`users:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

async function listarUsuariosAtivos(env) {
  const usuarios = [];
  let cursor;
  do {
    const list = await env.COMM_KV.list({ prefix: 'users:', cursor });
    for (const key of list.keys) {
      const raw = await env.COMM_KV.get(key.name);
      if (raw) {
        const u = JSON.parse(raw);
        if (u.ativo) usuarios.push({ chatId: key.name.replace('users:', ''), ...u });
      }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return usuarios;
}

async function getUltimoStatus(env) {
  const raw = await env.COMM_KV.get('deco:last_report');
  return raw ? JSON.parse(raw) : null;
}

async function setUltimoStatus(env, status) {
  await env.COMM_KV.put('deco:last_report', JSON.stringify(status));
}

async function getAlertaAtivo(env) {
  return (await env.COMM_KV.get('deco:alerta_ativo')) === '1';
}

async function setAlertaAtivo(env, ativo) {
  if (ativo) await env.COMM_KV.put('deco:alerta_ativo', '1');
  else await env.COMM_KV.delete('deco:alerta_ativo');
}

// ---------- Canal: Telegram ----------

async function telegramSendMessage(env, chatId, text) {
  await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// Ponto de extensao: outros canais (e-mail, web push) implementariam a mesma ideia de "enviar
// para um destinatario" e seriam adicionados aqui, roteados por preferencia do usuario.
async function notificarTodosAutorizados(env, texto) {
  const usuarios = await listarUsuariosAtivos(env);
  for (const u of usuarios) {
    await telegramSendMessage(env, u.chatId, texto);
  }
}

function formatarStatusDecos(status) {
  if (!status) return 'Nenhum relatorio de status recebido ainda.';
  const minutosAtras = Math.round((Date.now() - status.timestamp) / 60000);
  const linhas = Object.entries(status.equipamentos || {})
    .map(([nome, estado]) => `- ${nome}: ${estado === 'online' ? 'online' : 'OFFLINE'}`)
    .join('\n');
  return `Ultimo relatorio ha ${minutosAtras} min:\n${linhas}`;
}

// ---------- Comandos ----------

async function handleComando(env, chatId, texto) {
  const comando = texto.trim().toLowerCase();

  if (comando === '/start') {
    return telegramSendMessage(env, chatId, 'Canal de comunicacao ativo. Envie /ajuda para ver os comandos disponiveis.');
  }

  if (comando === '/ajuda') {
    return telegramSendMessage(env, chatId, 'Comandos disponiveis:\n/deco status - ultimo status conhecido da rede local');
  }

  if (comando === '/deco status') {
    const status = await getUltimoStatus(env);
    return telegramSendMessage(env, chatId, formatarStatusDecos(status));
  }

  return handleFallback(env, chatId, texto);
}

// Ponto de extensao: hoje so responde que nao reconheceu; no futuro pode chamar um LLM para
// interpretar linguagem livre e decidir a acao (ver plano do repo).
async function handleFallback(env, chatId, _texto) {
  return telegramSendMessage(env, chatId, 'Comando nao reconhecido. Envie /ajuda para ver as opcoes.');
}

// ---------- Webhook do Telegram ----------

async function handleTelegramWebhook(env, request) {
  const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const message = update.message;
  if (!message || !message.text) {
    return new Response('OK'); // ignora updates sem texto (edicoes, stickers, etc.)
  }

  const chatId = String(message.chat.id);
  const usuario = await getUsuario(env, chatId);
  if (!usuario || !usuario.ativo) {
    // Ignora silenciosamente updates de chat_ids nao autorizados.
    return new Response('OK');
  }

  await handleComando(env, chatId, message.text);
  return new Response('OK');
}

// ---------- Endpoint de status do dispositivo de monitoramento ----------

async function handleStatusReport(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || !env.ESP32_TOKEN || match[1] !== env.ESP32_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const status = { equipamentos: body.equipamentos || body, timestamp: Date.now() };
  await setUltimoStatus(env, status);

  // Se algum equipamento individual reportou offline, avisa na hora (nao espera o dead man's
  // switch, que cobre o cenario de silencio total).
  const algumOffline = Object.values(status.equipamentos).some(v => v === 'offline');
  if (algumOffline) {
    await notificarTodosAutorizados(env, `Status reportado:\n${formatarStatusDecos(status)}`);
  }

  // Report chegou = rede local esta viva; limpa qualquer alerta de "silencio" ativo.
  if (await getAlertaAtivo(env)) {
    await setAlertaAtivo(env, false);
    await notificarTodosAutorizados(env, 'O dispositivo de monitoramento voltou a reportar.');
  }

  return new Response('OK');
}

// ---------- Dead man's switch (cron) ----------

async function verificarDeadManSwitch(env) {
  const status = await getUltimoStatus(env);
  if (!status) return; // nunca reportou ainda, nada a comparar

  const decorridoMs = Date.now() - status.timestamp;
  const alertaJaAtivo = await getAlertaAtivo(env);

  if (decorridoMs > DEAD_MAN_TIMEOUT_MS && !alertaJaAtivo) {
    const minutos = Math.round(decorridoMs / 60000);
    await notificarTodosAutorizados(
      env,
      `Nenhum relatorio do dispositivo de monitoramento ha ${minutos} min. A rede local pode estar fora do ar.`
    );
    await setAlertaAtivo(env, true);
  }
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(env, request);
    }

    if (url.pathname === '/esp32/status' && request.method === 'POST') {
      return handleStatusReport(env, request);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(verificarDeadManSwitch(env));
  }
};
