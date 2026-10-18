#!/usr/bin/env bash
# Roteiro de testes do mcp-browser. Rode depois do deploy.
# Uso:  WORKER=https://mcp-browser.<seu-dominio> ORIGIN=https://browser.<seu-dominio> ./tests.sh
# A senha de aprovacao (MCP_SECRET) e pedida sem eco no terminal e nunca e impressa.
set -u
: "${WORKER:?defina WORKER}"
: "${ORIGIN:?defina ORIGIN}"
CB="https://claude.ai/api/mcp/auth_callback"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"teste","version":"1"}}}'

check() { # check <descricao> <obtido> <esperado (regex)>
  if [[ "$2" =~ ^($3)$ ]]; then echo "OK    $1 ($2)"; else echo "FALHA $1 (obtido $2, esperado $3)"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
jfield() { sed -n "s/.*\"$1\":\"\([^\"]*\\)\".*/\1/p"; } # extrai um campo string de um JSON simples

echo "== 1. Metadata =="
META=$(curl -s "$WORKER/.well-known/oauth-authorization-server")
check "registration_endpoint presente" "$(echo "$META" | grep -c registration_endpoint)" "1"
check "protected-resource" "$(code "$WORKER/.well-known/oauth-protected-resource")" "200"
check "protected-resource/mcp" "$(code "$WORKER/.well-known/oauth-protected-resource/mcp")" "200"

echo "== 2. Sem autenticacao =="
check "POST /mcp sem token" "$(code -X POST "$WORKER/mcp" -H 'Content-Type: application/json' -d "$INIT")" "401"
check "WWW-Authenticate aponta o metadata" "$(curl -si -X POST "$WORKER/mcp" -d "$INIT" | grep -ci 'resource_metadata=')" "1"
check "POST /mcp com Origin invalido" "$(code -X POST "$WORKER/mcp" -H 'Origin: https://evil.example' -d "$INIT")" "403"
check "caminho /outro" "$(code "$WORKER/outro")" "404"
check "PUT /mcp" "$(code -X PUT "$WORKER/mcp")" "405"
check "origin direto sem Service Token" "$(code -X POST "$ORIGIN/mcp" -d "$INIT")" "403"

echo "== 3. Registro dinamico (RFC 7591) =="
check "register com redirect_uri fora da allowlist" "$(code -X POST "$WORKER/register" -H 'Content-Type: application/json' -d '{"redirect_uris":["https://evil.example/cb"]}')" "400"
CLIENT_ID=$(curl -s -X POST "$WORKER/register" -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"teste\",\"redirect_uris\":[\"$CB\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}" | jfield client_id)
[[ -n "$CLIENT_ID" ]] && echo "OK    client_id obtido" || { echo "FALHA sem client_id, abortando"; exit 1; }

echo "== 4. Authorize (PKCE + resource) =="
read -rsp "MCP_SECRET (nao aparece na tela): " KEY; echo
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
authorize() { # authorize <senha>: imprime o cabecalho Location (ou vazio)
  curl -s -o /dev/null -D - -X POST "$WORKER/authorize" \
    --data-urlencode "key=$1" --data-urlencode "redirect_uri=$CB" --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" \
    --data-urlencode "response_type=code" --data-urlencode "state=x" --data-urlencode "resource=$WORKER/mcp"
}
check "senha errada" "$(authorize errada | awk 'NR==1{print $2}')" "401"
LOCATION=$(authorize "$KEY" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
unset KEY
CODE=${LOCATION#*code=}; CODE=${CODE%%&*}
[[ -n "$CODE" && "$LOCATION" == "$CB"* ]] && echo "OK    code recebido no callback" || { echo "FALHA sem code, abortando"; exit 1; }

echo "== 5. Token =="
check "verifier errado" "$(code -X POST "$WORKER/token" -d grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "redirect_uri=$CB" --data-urlencode "code_verifier=$(printf 'x%.0s' {1..43})")" "400"
TOKENS=$(curl -s -X POST "$WORKER/token" -d grant_type=authorization_code --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=$CB" --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "resource=$WORKER/mcp")
TOKEN=$(echo "$TOKENS" | jfield access_token)
REFRESH=$(echo "$TOKENS" | jfield refresh_token)
[[ -n "$TOKEN" ]] && echo "OK    access_token obtido" || { echo "FALHA sem token, abortando"; exit 1; }
[[ -n "$REFRESH" ]] && echo "OK    refresh_token obtido" || echo "FALHA sem refresh_token"

echo "== 6. Refresh =="
check "refresh_token" "$(code -X POST "$WORKER/token" -d grant_type=refresh_token --data-urlencode "refresh_token=$REFRESH" --data-urlencode "client_id=$CLIENT_ID")" "200"
check "refresh_token nao vale como Bearer" "$(code -X POST "$WORKER/mcp" -H "Authorization: Bearer $REFRESH" -d "$INIT")" "401"

echo "== 7. initialize =="
curl -s -D /tmp/mcp-h.txt -o /tmp/mcp-b.txt -X POST "$WORKER/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT"
check "initialize" "$(awk 'NR==1{print $2}' /tmp/mcp-h.txt)" "200"
SID=$(awk 'tolower($1)=="mcp-session-id:"{print $2}' /tmp/mcp-h.txt | tr -d '\r')
[[ -n "$SID" ]] && echo "OK    mcp-session-id presente" || echo "FALHA sem mcp-session-id"

echo "== 8. Headers CF-Access do cliente sao ignorados =="
check "CF-Access falso + sem Bearer" "$(code -X POST "$WORKER/mcp" -H 'CF-Access-Client-Id: x' -H 'CF-Access-Client-Secret: y' -d "$INIT")" "401"

echo "== 9. Streaming SSE sem buffer =="
echo "GET /mcp por 5 s; o primeiro byte deve chegar logo (tempo ate o primeiro byte abaixo):"
curl -s -N -m 5 -o /dev/null -w 'ttfb=%{time_starttransfer}s total=%{time_total}s\n' "$WORKER/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' -H "mcp-session-id: $SID"

echo "== 10. Logs =="
echo "Rode em outro terminal: npx wrangler tail mcp-browser --format pretty"
echo "Em caso de 502, procure o evento upstream_failure ou upstream_fetch_exception."
echo "Confirme que nenhum token, secret ou header aparece."
rm -f /tmp/mcp-h.txt /tmp/mcp-b.txt
