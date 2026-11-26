"""Download dos dados abertos de CNPJ da Receita Federal (compartilhamento Nextcloud oficial).

Retoma downloads interrompidos (HTTP Range) e baixa vários arquivos em paralelo.
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

SHARE_TOKEN = "YggdBLfdninEJX9"
WEBDAV = "https://arquivos.receitafederal.gov.br/public.php/webdav/"

ARQUIVOS_NECESSARIOS = re.compile(
    r"^(Estabelecimentos\d|Empresas\d|Socios\d|Simples|Municipios|Qualificacoes|Cnaes|Naturezas)\.zip$"
)

PROPFIND = """<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>
<d:getcontentlength/></d:prop></d:propfind>"""


def _sessao() -> requests.Session:
    s = requests.Session()
    s.auth = (SHARE_TOKEN, "")
    return s


def listar(caminho: str = "") -> list[tuple[str, int]]:
    """[(nome, tamanho)] dentro de uma pasta do compartilhamento."""
    for tentativa in range(5):
        try:
            r = _sessao().request("PROPFIND", WEBDAV + caminho, data=PROPFIND,
                                  headers={"Depth": "1"}, timeout=60)
            r.raise_for_status()
            break
        except requests.RequestException:
            if tentativa == 4:
                raise
            time.sleep(3 * (tentativa + 1))
    itens = []
    for bloco in re.findall(r"<d:response>(.*?)</d:response>", r.text, re.S):
        href = re.search(r"<d:href>([^<]+)</d:href>", bloco).group(1)
        nome = href.rstrip("/").split("/")[-1]
        tam = re.search(r"<d:getcontentlength>(\d+)", bloco)
        if href.rstrip("/") != ("/public.php/webdav/" + caminho).rstrip("/"):
            itens.append((nome, int(tam.group(1)) if tam else 0))
    return itens


def competencia_mais_recente() -> str:
    pastas = sorted(n for n, _ in listar() if re.fullmatch(r"\d{4}-\d{2}", n))
    return pastas[-1]


def baixar_arquivo(url: str, destino: Path, tamanho: int, log=print, tentativas: int = 30) -> None:
    if destino.exists() and destino.stat().st_size == tamanho:
        return
    parcial = destino.with_suffix(destino.suffix + ".part")
    sessao = _sessao()
    for tentativa in range(tentativas):
        feito = parcial.stat().st_size if parcial.exists() else 0
        if feito >= tamanho:
            break
        try:
            with sessao.get(url, headers={"Range": f"bytes={feito}-"}, stream=True,
                            timeout=(30, 120)) as r:
                if r.status_code not in (200, 206):
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                modo = "ab" if r.status_code == 206 else "wb"
                with parcial.open(modo) as f:
                    for bloco in r.iter_content(1 << 20):
                        f.write(bloco)
        except (requests.RequestException, OSError) as erro:
            log(f"  {destino.name}: conexão caiu em {feito / 1e6:.0f} MB ({erro.__class__.__name__}), retomando")
            time.sleep(min(60, 2 * (tentativa + 1)))
    if not parcial.exists() or parcial.stat().st_size != tamanho:
        raise RuntimeError(f"Download incompleto: {destino.name}")
    parcial.rename(destino)
    log(f"  ok {destino.name} ({tamanho / 1e6:.0f} MB)")


def baixar(pasta: str, competencia: str | None = None, paralelos: int = 4, log=print) -> Path:
    competencia = competencia or competencia_mais_recente()
    destino = Path(pasta) / competencia
    destino.mkdir(parents=True, exist_ok=True)
    arquivos = [(n, t) for n, t in listar(competencia + "/") if ARQUIVOS_NECESSARIOS.match(n)]
    total = sum(t for _, t in arquivos)
    log(f"Competência {competencia}: {len(arquivos)} arquivos, {total / 1e9:.1f} GB")
    # Maiores primeiro para o paralelismo terminar junto.
    arquivos.sort(key=lambda a: -a[1])
    with ThreadPoolExecutor(paralelos) as ex:
        futuros = [ex.submit(baixar_arquivo, f"{WEBDAV}{competencia}/{n}", destino / n, t, log)
                   for n, t in arquivos]
        for f in futuros:
            f.result()
    return destino
