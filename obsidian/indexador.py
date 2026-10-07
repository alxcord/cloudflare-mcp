#!/usr/bin/env python3
"""Indexa um vault Obsidian (pasta de arquivos .md) no Worker mcp-obsidian.

Fluxo:
  1. Lê os .md, remove imagens embutidas e extrai título, pasta e tags.
  2. Pede ao Worker o manifesto (caminho -> hash) do vault.
  3. Envia só as notas novas ou alteradas e apaga as que sumiram.

Só usa a biblioteca padrão do Python.

Uso:
  python indexador.py --vault trabalho --root ../vault --dry-run     (só mostra estatísticas)
  python indexador.py --vault trabalho --root ../vault             (indexa de verdade)

Variáveis de ambiente (ou argumentos):
  INDEX_ENDPOINT   URL base do Worker, ex.: https://mcp-obsidian.<seu-dominio>
  INDEX_API_TOKEN  API_TOKEN do Worker
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

# Muda quando as regras de limpeza mudam. Entra no hash e força reindexar tudo.
VERSAO_LIMPEZA = "1"

# Pastas que nunca entram no índice.
PASTAS_IGNORADAS = {".obsidian", ".git", ".github", ".indexer", ".trash", "node_modules"}

# Limite do texto de cada nota (caracteres). Protege contra notas gigantes.
LIMITE_CORPO = 400_000

# Limites de cada requisição de envio ao Worker.
MAX_NOTAS_POR_LOTE = 10
MAX_BYTES_POR_LOTE = 200_000

# Extensões de mídia: embeds com esses arquivos são removidos do texto.
EXT_MIDIA = {
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tif", "tiff", "heic",
    "pdf", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "mov", "webm", "mkv", "avi",
}

# ---------- expressões regulares ----------
RE_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)
RE_CERCA_CODIGO = re.compile(r"(```|~~~).*?(\1|\Z)", re.S)
RE_CODIGO_INLINE = re.compile(r"`[^`\n]*`")
RE_EMBED_WIKI = re.compile(r"!\[\[([^\]\n]+)\]\]")
RE_IMG_MD = re.compile(r"!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)")
RE_IMG_REF = re.compile(r"!\[[^\]\n]*\]\[[^\]\n]*\]")
RE_IMG_HTML = re.compile(r"<img\b[^>]*>", re.I)
# Definições de imagem por referência, comuns em texto colado do Word/Docs:
#   [image1]: <data:image/png;base64,....>
RE_DEF_DATA = re.compile(r"^\[[^\]\n]+\]:\s*<?data:[^\n]*$", re.M)
# Qualquer base64 longo que sobrar.
RE_DATA_URI = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{100,}")
RE_WIKILINK = re.compile(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]")
RE_LINHAS_VAZIAS = re.compile(r"\n{3,}")
# Tag no corpo: #palavra precedida de início de linha, espaço ou "(".
# Não começa com número (Obsidian não aceita tag só numérica).
RE_TAG_INLINE = re.compile(r"(?:^|(?<=[\s(]))#([^\W\d][\w/\-]*)", re.M)


def normaliza_tag(tag):
    """Minúsculas, sem acento, sem '#', espaços viram '-'."""
    tag = tag.strip().strip("'\"").lstrip("#").strip().lower()
    tag = unicodedata.normalize("NFKD", tag)
    tag = "".join(c for c in tag if not unicodedata.combining(c))
    tag = re.sub(r"\s+", "-", tag).strip("/-")
    return tag


def expande_hierarquia(tags):
    """'a/b/c' também gera 'a' e 'a/b', como a busca por tag do Obsidian."""
    saida = set()
    for tag in tags:
        if not tag or len(tag) > 50:
            continue
        partes = tag.split("/")
        for i in range(1, len(partes) + 1):
            saida.add("/".join(partes[:i]))
    return sorted(saida)


def separa_frontmatter(texto):
    """Devolve (frontmatter, corpo). Frontmatter vem vazio se a nota não tiver."""
    m = RE_FRONTMATTER.match(texto)
    if not m:
        return "", texto
    return m.group(1), texto[m.end():]


def tags_do_frontmatter(fm):
    """Lê o campo tags/tag nos três formatos: lista YAML, [a, b] e 'a, b'.

    Devolve (tags, frontmatter_sem_o_bloco_de_tags).
    """
    tags = []
    restante = []
    linhas = fm.splitlines()
    i = 0
    while i < len(linhas):
        m = re.match(r"^tags?\s*:\s*(.*)$", linhas[i], re.I)
        if not m:
            restante.append(linhas[i])
            i += 1
            continue
        valor = m.group(1).strip()
        i += 1
        if valor:
            # Formato em uma linha: [a, b] ou a, b
            tags += [t for t in re.split(r"[,\[\]]+", valor) if t.strip()]
        else:
            # Formato em lista, uma tag por linha começando com "-"
            while i < len(linhas):
                item = re.match(r"^\s*-\s*(.*)$", linhas[i])
                if not item:
                    break
                tags.append(item.group(1))
                i += 1
    return tags, "\n".join(restante)


def tags_do_corpo(corpo):
    """Acha #tags no texto, ignorando blocos e trechos de código."""
    sem_codigo = RE_CERCA_CODIGO.sub("", corpo)
    sem_codigo = RE_CODIGO_INLINE.sub("", sem_codigo)
    return RE_TAG_INLINE.findall(sem_codigo)


def troca_embed(m):
    """Remove embeds de mídia. Embed de outra nota vira só o nome dela."""
    alvo = m.group(1).split("|")[0].split("#")[0].strip()
    ext = alvo.rsplit(".", 1)[-1].lower() if "." in alvo else ""
    return "" if ext in EXT_MIDIA else alvo


def troca_wikilink(m):
    """[[alvo|apelido]] vira apelido; [[alvo]] vira alvo."""
    return (m.group(2) or m.group(1)).strip()


def limpa_corpo(corpo):
    """Tira imagens embutidas e base64 do texto, sem mexer no resto."""
    corpo = RE_DEF_DATA.sub("", corpo)
    corpo = RE_EMBED_WIKI.sub(troca_embed, corpo)
    corpo = RE_IMG_MD.sub("", corpo)
    corpo = RE_IMG_REF.sub("", corpo)
    corpo = RE_IMG_HTML.sub("", corpo)
    corpo = RE_DATA_URI.sub("", corpo)
    corpo = RE_WIKILINK.sub(troca_wikilink, corpo)
    corpo = RE_LINHAS_VAZIAS.sub("\n\n", corpo)
    return corpo.strip()


def processa_nota(raiz, caminho_rel):
    """Lê um .md e devolve o registro pronto para enviar (ou None se vazia)."""
    with open(os.path.join(raiz, caminho_rel), "rb") as f:
        bruto = f.read()
    texto = bruto.decode("utf-8", errors="replace").lstrip("﻿")
    if not texto.strip():
        return None

    fm, corpo = separa_frontmatter(texto)
    tags_fm, fm_sem_tags = tags_do_frontmatter(fm)
    tags_brutas = tags_fm + tags_do_corpo(corpo)
    tags = expande_hierarquia(normaliza_tag(t) for t in tags_brutas)

    # O frontmatter (sem as tags) entra no texto: tem campos úteis como Desc-Curta.
    texto_busca = limpa_corpo((fm_sem_tags + "\n\n" + corpo) if fm_sem_tags.strip() else corpo)
    texto_busca = texto_busca[:LIMITE_CORPO]
    if not texto_busca and not tags:
        return None

    pasta, arquivo = os.path.split(caminho_rel)
    titulo = arquivo[:-3] if arquivo.lower().endswith(".md") else arquivo
    hash_ = hashlib.sha256(
        json.dumps([VERSAO_LIMPEZA, titulo, tags, texto_busca], ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:20]
    return {
        "path": caminho_rel.replace(os.sep, "/"),
        "title": titulo,
        "folder": pasta.replace(os.sep, "/"),
        "tags": tags,
        "sha": hash_,
        "size": len(bruto),
        "body": texto_busca,
    }


def lista_notas(raiz):
    """Percorre o vault e devolve os caminhos relativos dos .md."""
    achados = []
    for pasta, subpastas, arquivos in os.walk(raiz):
        subpastas[:] = [d for d in subpastas if d not in PASTAS_IGNORADAS]
        for nome in arquivos:
            if nome.lower().endswith(".md"):
                achados.append(os.path.relpath(os.path.join(pasta, nome), raiz))
    return sorted(achados)


# ---------- comunicação com o Worker ----------
def chama_worker(endpoint, token, metodo, rota, corpo=None):
    """Chama a API do Worker com até 3 tentativas em caso de erro temporário."""
    url = endpoint.rstrip("/") + rota
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    for tentativa in range(1, 4):
        req = urllib.request.Request(url, data=dados, method=metodo)
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", "obsidian-indexer/1.0")  # a Cloudflare bloqueia o UA padrão do Python
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detalhe = e.read().decode("utf-8", errors="replace")[:300]
            if e.code in (429, 500, 502, 503, 504) and tentativa < 3:
                time.sleep(2 * tentativa)
                continue
            raise SystemExit(f"Erro {e.code} em {rota}: {detalhe}")
        except urllib.error.URLError as e:
            if tentativa < 3:
                time.sleep(2 * tentativa)
                continue
            raise SystemExit(f"Falha de rede em {rota}: {e}")


def monta_lotes(notas):
    """Agrupa notas em lotes limitados por quantidade e por tamanho em bytes."""
    lote, bytes_lote = [], 0
    for nota in notas:
        tamanho = len(nota["body"].encode("utf-8")) + 500
        if lote and (len(lote) >= MAX_NOTAS_POR_LOTE or bytes_lote + tamanho > MAX_BYTES_POR_LOTE):
            yield lote
            lote, bytes_lote = [], 0
        lote.append(nota)
        bytes_lote += tamanho
    if lote:
        yield lote


def mostra_estatisticas(notas, ignoradas):
    total_corpo = sum(len(n["body"]) for n in notas)
    todas_tags = {}
    for n in notas:
        for t in n["tags"]:
            todas_tags[t] = todas_tags.get(t, 0) + 1
    maiores = sorted(notas, key=lambda n: len(n["body"]), reverse=True)[:5]
    print(f"Notas a indexar: {len(notas)} (ignoradas por estarem vazias: {ignoradas})")
    print(f"Texto total após limpeza: {total_corpo / 1024 / 1024:.2f} MB")
    print(f"Notas com tags: {sum(1 for n in notas if n['tags'])} | tags distintas: {len(todas_tags)} | "
          f"vínculos nota-tag: {sum(todas_tags.values())}")
    print("Tags mais usadas:", ", ".join(f"{t}({c})" for t, c in
                                         sorted(todas_tags.items(), key=lambda x: -x[1])[:10]))
    print("Maiores notas após limpeza:")
    for n in maiores:
        print(f"  {len(n['body']) / 1024:8.1f} KB  (original {n['size'] / 1024:.1f} KB)  {n['path']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", required=True, help="id do vault, ex.: trabalho")
    ap.add_argument("--root", default=".", help="pasta raiz do vault")
    ap.add_argument("--endpoint", default=os.environ.get("INDEX_ENDPOINT", ""))
    ap.add_argument("--token", default=os.environ.get("INDEX_API_TOKEN", ""))
    ap.add_argument("--dry-run", action="store_true", help="só lê e mostra estatísticas")
    ap.add_argument("--force", action="store_true", help="reenvia tudo, ignorando o manifesto")
    ap.add_argument("--max-escritas", type=int, default=50_000,
                    help="máximo de linhas escritas no D1 por execução (limite gratuito: 100 mil por dia)")
    args = ap.parse_args()

    # 1. Lê e limpa as notas locais
    notas, ignoradas = {}, 0
    for caminho in lista_notas(args.root):
        nota = processa_nota(args.root, caminho)
        if nota is None:
            ignoradas += 1
        else:
            notas[nota["path"]] = nota

    if args.dry_run:
        mostra_estatisticas(list(notas.values()), ignoradas)
        return
    if not args.endpoint or not args.token:
        raise SystemExit("Defina INDEX_ENDPOINT e INDEX_API_TOKEN (ou use --endpoint e --token).")

    # 2. Compara com o que já está no índice
    manifesto = {}
    if not args.force:
        manifesto = chama_worker(args.endpoint, args.token, "GET",
                                 "/api/manifest?vault=" + urllib.request.quote(args.vault))["notes"]
    novas = [n for p, n in notas.items() if manifesto.get(p) != n["sha"]]
    apagadas = [p for p in manifesto if p not in notas]
    print(f"Vault '{args.vault}': {len(notas)} notas locais | {len(novas)} para enviar | {len(apagadas)} para apagar")

    # 3. Envia as alteradas, em lotes
    enviadas = 0
    escritas = 0
    for lote in monta_lotes(novas):
        # Trava de segurança: o limite diário de escrita do D1 vale para a conta toda.
        # Ao passar do orçamento, para aqui. A próxima execução continua de onde parou.
        if escritas >= args.max_escritas:
            print(f"Orçamento de {args.max_escritas} linhas escritas atingido. "
                  f"Faltam {len(novas) - enviadas} notas, que seguem na próxima execução.")
            break
        resp = chama_worker(args.endpoint, args.token, "POST", "/api/ingest", {"vault": args.vault, "notes": lote})
        enviadas += len(lote)
        escritas += resp.get("rows_written", 0)
        print(f"  enviadas {enviadas}/{len(novas)} (linhas escritas no D1 até agora: {escritas})")

    # 4. Apaga do índice as que não existem mais
    for i in range(0, len(apagadas), 100):
        chama_worker(args.endpoint, args.token, "POST", "/api/delete",
                     {"vault": args.vault, "paths": apagadas[i:i + 100]})
    print("Concluído.")


if __name__ == "__main__":
    sys.exit(main())
