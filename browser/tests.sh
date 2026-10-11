#!/usr/bin/env bash
# Roteiro de testes do mcp-browser. Rode depois do deploy.
# Uso:  WORKER=https://mcp-browser.<seu-dominio> ORIGIN=https://browser.<seu-dominio> ./tests.sh
# O MCP_SECRET e pedido sem eco no terminal e nunca e impresso.
set -u
: "${WORKER:?defina WORKER}"
: "${ORIGIN:?defina ORIGIN}"
CB="https://claude.ai/api/mcp/auth_callback"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"teste","version":"1"}}}'

check() { # check <descricao> <obtido> <esperado (regex)>
  if [[ "$2" =~ ^($3)$ ]]; then echo "OK    $1 ($2)"; else echo "FALHA $1 (obtido $2, esperado $3)"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== Sem autenticacao =="
check "POST /mcp sem token" "$(code -X POST "$WORKER/mcp" -H 'Content-Type: application/json' -d "$INIT")" "401|403"
check "POST /mcp com Origin invalido" "$(code -X POST "$WORKER/mcp" -H 'Origin: https://evil.example' -d "$INIT")" "403"

echo "== Allowlist de caminho e metodo =="
check "caminho /outro" "$(code "$WORKER/outro")" "404"
check "PUT /mcp" "$(code -X PUT "$WORKER/mcp")" "405"
check "PATCH /mcp" "$(code -X PATCH "$WORKER/mcp")" "405"

echo "== Origin direto sem token =="
check "origin sem Service Token" "$(code -X POST "$ORIGIN/mcp" -d "$INIT")" "403"

echo "== Fluxo OAuth (PKCE) para obter um token de teste =="
read -rsp "MCP_SECRET (nao aparece na tela): " KEY; echo
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
LOCATION=$(curl -s -o /dev/null -D - -X POST "$WORKER/authorize" \
  --data-urlencode "key=$KEY" --data-urlencode "redirect_uri=$CB" --data-urlencode "client_id=teste" \
  --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "response_type=code" --data-urlencode "state=x" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
unset KEY
CODE=${LOCATION#*code=}; CODE=${CODE%%&*}
TOKEN=$(curl -s -X POST "$WORKER/token" -d grant_type=authorization_code --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$CB" --data-urlencode "code_verifier=$VERIFIER" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[[ -n "$TOKEN" ]] && echo "OK    token obtido" || { echo "FALHA sem token, abortando"; exit 1; }

echo "== initialize =="
curl -s -D /tmp/mcp-h.txt -o /tmp/mcp-b.txt -X POST "$WORKER/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT"
check "initialize" "$(awk 'NR==1{print $2}' /tmp/mcp-h.txt)" "200"
SID=$(awk 'tolower($1)=="mcp-session-id:"{print $2}' /tmp/mcp-h.txt | tr -d '\r')
[[ -n "$SID" ]] && echo "OK    mcp-session-id presente" || echo "FALHA sem mcp-session-id"

echo "== Headers CF-Access do cliente sao ignorados =="
check "CF-Access falso + sem Bearer" "$(code -X POST "$WORKER/mcp" -H 'CF-Access-Client-Id: x' -H 'CF-Access-Client-Secret: y' -d "$INIT")" "401|403"

echo "== Streaming SSE sem buffer =="
echo "GET /mcp por 5 s; o primeiro byte deve chegar logo (tempo ate o primeiro byte abaixo):"
curl -s -N -m 5 -o /dev/null -w 'ttfb=%{time_starttransfer}s total=%{time_total}s\n' "$WORKER/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' -H "mcp-session-id: $SID"

echo "== Logs =="
echo "Rode em outro terminal: npx wrangler tail mcp-browser --format pretty"
echo "Repita este script e confirme que nenhum token, secret ou header aparece."
rm -f /tmp/mcp-h.txt /tmp/mcp-b.txt
