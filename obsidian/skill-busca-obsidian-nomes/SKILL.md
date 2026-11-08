---
name: busca-obsidian-nomes
description: Use quando Alex perguntar sobre suas notas ou seu conhecimento guardado nos vaults Obsidian (trabalho e pessoal). Busca só os nomes dos arquivos no índice e lê o conteúdo direto no GitHub.
---

# Busca de notas Obsidian por nomes

Esta skill responde perguntas sobre as notas de Alex em duas etapas. Primeiro a busca REST devolve só os nomes dos arquivos, em ordem de relevância, junto com as datas de atualização do índice. Depois o conteúdo é lido direto no repositório do vault no GitHub. Nunca se pede nem se lista o vault inteiro.

1. Monte uma consulta curta, com 1 a 4 termos. Use aspas para frase exata, como "control-m". Os termos casam por prefixo e todos precisam aparecer na nota, então termos demais zeram o resultado.

2. Chame `GET https://mcp-obsidian.alexcordeiro.dev/api/search` com os parâmetros `q` (obrigatório), `vault` (`trabalho` ou `pessoal`, opcional), `pasta` (prefixo de pasta, opcional) e `limite` (padrão 10, máximo 30). A autenticação usa o bearer token configurado no conector ou na Action. O token nunca aparece neste texto, na URL ou na resposta ao usuário.

3. Antes de usar os resultados, leia a seção `atualizacao`. Se `ultima_execucao_sync` for `null` ou tiver mais de 48 horas, avise que o índice pode estar parado. Compare também `commit_indexado.data` com o último commit do repositório do vault no GitHub (list_commits). Se o commit do repositório for mais novo, avise que o índice está atrasado em relação ao repositório. Informe sempre, na resposta, a data da última atualização do índice (`ultima_execucao_sync` e `ultima_nota_alterada`).

4. Leia os 3 primeiros arquivos da lista pelo GitHub (get_file_contents). O vault `trabalho` fica em `alxcord/obsidian-trabalho` e o vault `pessoal` em `alxcord/obsidian-pessoal`. O campo `path` do índice é o caminho do arquivo dentro do repositório.

5. Abra mais arquivos só se os três primeiros não bastarem. Se a busca devolver 0 resultados, reformule uma única vez com menos termos ou com sinônimos e tente de novo.

6. Responda citando o caminho das notas usadas e sem inventar conteúdo. Se o arquivo não existir no GitHub, avise que o índice pode estar defasado.

7. Nunca peça nem liste o vault inteiro. A busca devolve no máximo 30 nomes e a leitura se limita aos arquivos que a pergunta exige.

A busca REST não devolve trechos, tags nem tamanho. Pastas bloqueadas no servidor (variável `BLOCKED_FOLDERS`) nunca aparecem nos resultados, e a skill não deve tentar contornar isso.
