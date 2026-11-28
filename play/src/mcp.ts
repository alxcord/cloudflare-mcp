// Protocolo MCP (JSON-RPC 2.0 sobre HTTP, sem SDK): initialize, ping, tools/list e tools/call.

import { type FetchFn, GoogleTokenProvider } from './google-auth.ts';
import { PlayApi } from './play-api.ts';
import { callTool, TOOLS } from './tools.ts';
import { packageList } from './validate.ts';

const SERVER_INFO = { name: 'mcp-play', version: '1.0.0' };
// Versoes do protocolo aceitas. Se o cliente pedir outra, respondemos a mais recente.
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface GoogleConfig {
  googleEmail: string;
  googleKey: string;
  missing: string[]; // nomes dos secrets do Google que faltam
  playPackages?: string; // valor do secret opcional PLAY_PACKAGES
}

// Um provedor de token por isolate: o access token fica em cache entre requisicoes.
const defaultTokens = new GoogleTokenProvider();

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: any };

function result(id: RpcMessage['id'], value: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id: RpcMessage['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// Trata uma mensagem JSON-RPC. Devolve null para notificacoes (sem id), que nao tem resposta.
// fetchFn e tokens sao injetaveis para os testes.
export async function handleMcpMessage(message: unknown, cfg: GoogleConfig, fetchFn?: FetchFn, tokens: GoogleTokenProvider = defaultTokens) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return error(null, -32600, 'Invalid Request: envie um unico objeto JSON-RPC');
  }
  const msg = message as RpcMessage;
  const isNotification = !('id' in msg) || msg.id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : error(msg.id, -32600, 'Invalid Request');
  }
  if (isNotification) return null; // ex.: notifications/initialized

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return result(msg.id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return result(msg.id, {});
    case 'tools/list':
      return result(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments;
      if (typeof name !== 'string') return error(msg.id, -32602, 'Invalid params: name e obrigatorio');
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        return error(msg.id, -32602, 'Invalid params: arguments precisa ser um objeto');
      }
      // Sem credencial do Google, a ferramenta falha com o nome do secret que falta.
      if (cfg.missing.length) {
        return result(msg.id, { content: [{ type: 'text', text: `Worker sem configuracao: faltam os secrets ${cfg.missing.join(', ')}` }], isError: true });
      }
      const sa = { email: cfg.googleEmail, privateKeyPem: cfg.googleKey };
      const api = new PlayApi(() => tokens.getToken(sa), fetchFn);
      return result(msg.id, await callTool({ api, extraPackages: packageList(cfg.playPackages) }, name, args ?? {}));
    }
    default:
      return error(msg.id, -32601, `Method not found: ${msg.method.slice(0, 60)}`);
  }
}
