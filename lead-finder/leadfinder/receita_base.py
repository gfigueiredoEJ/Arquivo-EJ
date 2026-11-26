"""Base local com os dados abertos de CNPJ da Receita Federal (SQLite).

Importa só estabelecimentos ATIVOS da Região Metropolitana do Rio e descarta
e-mail, telefone, CPF e faixa etária dos arquivos brutos (podem ser pessoais).
MEIs são removidos no fim da importação.

Usos:
- casar(): achar o CNPJ de uma empresa do Google Maps pelo CEP + número + nome;
- interpretar_local(): mesmos campos de cnpj.interpretar(), sem chamar a BrasilAPI;
- descobrir(): listar empresas por CNAE e bairro direto da Receita.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
import sqlite3
import zipfile
from pathlib import Path

from .cnpj import formatar_cnpj, somente_digitos
from .scoring import normalizar, tokens_nome

PORTE = {"00": "não informado", "01": "ME", "03": "EPP", "05": "DEMAIS"}
SITUACAO_ATIVA = "02"

ESQUEMA = """
CREATE TABLE IF NOT EXISTS meta(chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS estab(
    cnpj TEXT PRIMARY KEY, basico TEXT, matriz INTEGER, fantasia TEXT, inicio TEXT,
    cnae TEXT, cnaes_sec TEXT, logradouro TEXT, numero TEXT, complemento TEXT,
    bairro TEXT, bairro_norm TEXT, cep TEXT, municipio TEXT, municipio_norm TEXT);
CREATE TABLE IF NOT EXISTS empresa(
    basico TEXT PRIMARY KEY, razao TEXT, natureza TEXT, capital REAL, porte TEXT);
CREATE TABLE IF NOT EXISTS socio(basico TEXT, nome TEXT, qualificacao TEXT);
CREATE TABLE IF NOT EXISTS simples(basico TEXT PRIMARY KEY, simples TEXT, mei TEXT);
CREATE TABLE IF NOT EXISTS cnae(codigo TEXT PRIMARY KEY, descricao TEXT);
CREATE TABLE IF NOT EXISTS qualificacao(codigo TEXT PRIMARY KEY, descricao TEXT);
"""
INDICES = """
CREATE INDEX IF NOT EXISTS ix_estab_cep ON estab(cep, numero);
CREATE INDEX IF NOT EXISTS ix_estab_basico ON estab(basico);
CREATE INDEX IF NOT EXISTS ix_estab_cnae ON estab(cnae, municipio_norm, bairro_norm);
CREATE INDEX IF NOT EXISTS ix_socio ON socio(basico);
CREATE VIRTUAL TABLE IF NOT EXISTS nomes USING fts5(
    cnpj UNINDEXED, texto, tokenize='unicode61 remove_diacritics 2');
"""

CEP_RE = re.compile(r"\b(\d{5})-?(\d{3})\b")
NUMERO_RE = re.compile(r",\s*(\d{1,6})\b")


# ---------------------------------------------------------------- importação

def _linhas(zip_path: Path):
    with zipfile.ZipFile(zip_path) as zf:
        for nome in zf.namelist():
            with zf.open(nome) as bruto:
                yield from io.TextIOWrapper(bruto, encoding="latin-1", newline="")


def _registros(zip_path: Path, filtro_bruto=None):
    """csv.reader sobre as linhas que passam no filtro rápido de texto."""
    linhas = _linhas(zip_path)
    if filtro_bruto:
        linhas = (l for l in linhas if filtro_bruto(l))
    yield from csv.reader(linhas, delimiter=";", quotechar='"')


def _numero(valor: str) -> str:
    v = re.sub(r"\D", "", valor or "")
    return v.lstrip("0") or ""


def conectar(caminho: str | Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(caminho))
    con.row_factory = sqlite3.Row
    return con


def importar(pasta_zips: str | Path, banco: str | Path, municipios_aceitos: list[str],
             competencia: str = "", log=print) -> None:
    pasta = Path(pasta_zips)
    banco = Path(banco)
    banco.parent.mkdir(parents=True, exist_ok=True)
    temporario = banco.with_suffix(".importando")
    temporario.unlink(missing_ok=True)
    con = conectar(temporario)
    con.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;" + ESQUEMA)

    # Tabelas auxiliares
    alvo = {normalizar(m) for m in municipios_aceitos}
    codigos_municipio = {}
    for cod, nome in _registros(pasta / "Municipios.zip"):
        if normalizar(nome) in alvo:
            codigos_municipio[cod] = nome.title()
    faltando = alvo - {normalizar(n) for n in codigos_municipio.values()}
    if faltando:
        log(f"Aviso: municípios não encontrados na tabela da Receita: {sorted(faltando)}")
    con.executemany("INSERT INTO cnae VALUES (?,?)", _registros(pasta / "Cnaes.zip"))
    con.executemany("INSERT INTO qualificacao VALUES (?,?)", _registros(pasta / "Qualificacoes.zip"))

    # Estabelecimentos ativos da Região Metropolitana
    basicos: set[str] = set()
    total = 0
    for arq in sorted(pasta.glob("Estabelecimentos*.zip")):
        lote = []
        for r in _registros(arq, lambda l: '";"RJ";"' in l):
            if len(r) < 21 or r[5] != SITUACAO_ATIVA or r[19] != "RJ" or r[20] not in codigos_municipio:
                continue
            municipio = codigos_municipio[r[20]]
            lote.append((
                r[0] + r[1] + r[2], r[0], 1 if r[3] == "1" else 0, r[4].strip(), r[10],
                r[11], r[12], f"{r[13]} {r[14]}".strip().title(), _numero(r[15]),
                r[16].strip(), r[17].strip().title(), normalizar(r[17]), r[18],
                municipio, normalizar(municipio),
            ))
            basicos.add(r[0])
            if len(lote) >= 50_000:
                con.executemany("INSERT OR IGNORE INTO estab VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", lote)
                total += len(lote)
                lote = []
        con.executemany("INSERT OR IGNORE INTO estab VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", lote)
        total += len(lote)
        log(f"  {arq.name}: {total:,} estabelecimentos até agora".replace(",", "."))

    def _filtrado(prefixo: str, tabela: str, conversor, colunas: int):
        lote = []
        for arq in sorted(pasta.glob(f"{prefixo}*.zip")):
            for r in _registros(arq, lambda l: l[1:9] in basicos):
                if r[0] in basicos:
                    lote.append(conversor(r))
                if len(lote) >= 50_000:
                    con.executemany(f"INSERT OR IGNORE INTO {tabela} VALUES ({','.join('?' * colunas)})", lote)
                    lote = []
            log(f"  {arq.name}: ok")
        con.executemany(f"INSERT OR IGNORE INTO {tabela} VALUES ({','.join('?' * colunas)})", lote)

    _filtrado("Empresas", "empresa",
              lambda r: (r[0], r[1].strip(), r[2], float(r[4].replace(".", "").replace(",", ".") or 0), r[5]), 5)
    # Sócios: só nome e qualificação. CPF, faixa etária e representante legal ficam de fora.
    _filtrado("Socios", "socio", lambda r: (r[0], r[2].strip(), r[4]), 3)
    _filtrado("Simples", "simples", lambda r: (r[0], r[1], r[4]), 3)

    log("Removendo MEIs e criando índices...")
    con.execute("DELETE FROM estab WHERE basico IN (SELECT basico FROM simples WHERE mei = 'S')")
    con.execute("DELETE FROM empresa WHERE basico NOT IN (SELECT basico FROM estab)")
    con.execute("DELETE FROM socio WHERE basico NOT IN (SELECT basico FROM estab)")
    con.executescript(INDICES)
    con.execute("""INSERT INTO nomes SELECT e.cnpj, e.fantasia || ' ' || COALESCE(m.razao, '')
                   FROM estab e LEFT JOIN empresa m USING(basico)""")
    con.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [
        ("competencia", competencia), ("importado_em", dt.date.today().isoformat()),
        ("estabelecimentos", str(con.execute("SELECT COUNT(*) FROM estab").fetchone()[0])),
    ])
    con.commit()
    con.execute("VACUUM")
    con.close()
    temporario.replace(banco)
    log(f"Base pronta: {banco}")


# ---------------------------------------------------------------- consultas

def competencia(con) -> str:
    linha = con.execute("SELECT valor FROM meta WHERE chave='competencia'").fetchone()
    return linha[0] if linha else ""


def _decisor(con, basico: str) -> tuple[str, str]:
    from .cnpj import PRIORIDADE_DECISOR, _titulo
    socios = con.execute(
        """SELECT s.nome, COALESCE(q.descricao, s.qualificacao) AS qualif FROM socio s
           LEFT JOIN qualificacao q ON q.codigo = s.qualificacao WHERE s.basico = ?""",
        (basico,)).fetchall()
    for alvo in PRIORIDADE_DECISOR:
        for s in socios:
            if alvo in (s["qualif"] or "").lower():
                return _titulo(s["nome"]), s["qualif"]
    if socios:
        return _titulo(socios[0]["nome"]), socios[0]["qualif"] or "não encontrado"
    return "não encontrado", "não encontrado"


def interpretar_local(con, cnpj: str, hoje: dt.date | None = None) -> dict | None:
    hoje = hoje or dt.date.today()
    c = somente_digitos(cnpj)
    e = con.execute(
        """SELECT e.*, m.razao, m.capital, m.porte, s.simples, c.descricao AS cnae_desc
           FROM estab e LEFT JOIN empresa m USING(basico) LEFT JOIN simples s USING(basico)
           LEFT JOIN cnae c ON c.codigo = e.cnae WHERE e.cnpj = ?""", (c,)).fetchone()
    if e is None:
        return None
    abertura = None
    anos = None
    if e["inicio"] and len(e["inicio"]) == 8:
        d = dt.date(int(e["inicio"][:4]), int(e["inicio"][4:6]), int(e["inicio"][6:]))
        abertura = d.isoformat()
        anos = round((hoje - d).days / 365.25, 1)
    unidades = con.execute("SELECT COUNT(*) FROM estab WHERE basico = ?", (e["basico"],)).fetchone()[0]
    decisor, cargo = _decisor(con, e["basico"])
    return {
        "cnpj": formatar_cnpj(c),
        "razao_social": e["razao"] or "não encontrado",
        "nome_fantasia": (e["fantasia"] or "").title(),
        "cnae": e["cnae"],
        "cnae_descricao": e["cnae_desc"] or "",
        "porte": PORTE.get(e["porte"], "não informado"),
        "capital_social": float(e["capital"] or 0),
        "data_abertura": abertura or "não encontrado",
        "anos_cnpj": anos,
        "situacao": "ATIVA",
        "bairro_receita": e["bairro"],
        "municipio": e["municipio"],
        "cep_receita": e["cep"],
        "matriz_filial": "MATRIZ" if e["matriz"] else "FILIAL",
        "unidades_receita": unidades,
        "decisor": decisor,
        "cargo": cargo,
    }


def extrair_endereco(endereco: str) -> tuple[str, str]:
    """(cep, número) de um endereço no formato do Google Maps."""
    cep = CEP_RE.search(endereco or "")
    numero = NUMERO_RE.search(endereco or "")
    return (cep.group(1) + cep.group(2) if cep else "",
            numero.group(1).lstrip("0") if numero else "")


def _similaridade(nome: str, candidato: sqlite3.Row) -> float | None:
    a = tokens_nome(nome)
    if not a:
        return None  # nome só com palavras genéricas ("Clínica Odontológica")
    b = tokens_nome(f"{candidato['fantasia']} {candidato['razao'] or ''}")
    return len(a & b) / len(a)


def casar(con, empresa: str, endereco: str = "", cnaes: list[str] | None = None) -> dict:
    """Procura o CNPJ de uma empresa vista no Google Maps.

    Retorna {"cnpj", "confianca": "alta"|"média", "motivo"} ou {"cnpj": None, "motivo"}.
    Só aceita quando o endereço e/ou o nome apontam para um único estabelecimento.
    """
    cnaes = set(cnaes or [])
    cep, numero = extrair_endereco(endereco)
    sql = """SELECT e.cnpj, e.fantasia, e.cnae, e.numero, e.bairro_norm, m.razao
             FROM estab e LEFT JOIN empresa m USING(basico) WHERE """

    def ordenar(candidatos):
        pontuados = []
        for c in candidatos:
            sim = _similaridade(empresa, c)
            pontuados.append((sim if sim is not None else -1, c["cnae"] in cnaes, c))
        pontuados.sort(key=lambda t: (t[0], t[1]), reverse=True)
        return pontuados

    if cep and numero:
        cands = con.execute(sql + "e.cep = ? AND e.numero = ?", (cep, numero)).fetchall()
        if cands:
            ps = ordenar(cands)
            melhor_sim, melhor_cnae, melhor = ps[0]
            segundo = ps[1][0] if len(ps) > 1 else -1
            if melhor_sim >= 0.5 and melhor_sim > segundo:
                return {"cnpj": melhor["cnpj"], "confianca": "alta",
                        "motivo": f"CEP, número e nome batem ({len(cands)} CNPJ(s) no endereço)"}
            if len(cands) == 1 and (melhor_sim > 0 or (melhor_sim == -1 and melhor_cnae)):
                return {"cnpj": melhor["cnpj"], "confianca": "média",
                        "motivo": "único CNPJ ativo no endereço; nome só confirma em parte"}
            return {"cnpj": None,
                    "motivo": f"{len(cands)} CNPJ(s) no endereço, nenhum com nome compatível"}

    if cep:
        cands = con.execute(sql + "e.cep = ?", (cep,)).fetchall()
        ps = ordenar(cands)
        if ps and ps[0][0] >= 0.5 and (len(ps) == 1 or ps[0][0] > ps[1][0]):
            return {"cnpj": ps[0][2]["cnpj"], "confianca": "média",
                    "motivo": "CEP e nome batem (sem número no endereço)"}

    termos = " ".join(f'"{t}"' for t in sorted(tokens_nome(empresa)))
    if termos:
        cands = con.execute(
            sql + "e.cnpj IN (SELECT cnpj FROM nomes WHERE nomes MATCH ? LIMIT 50)", (termos,)
        ).fetchall()
        ps = [p for p in ordenar(cands) if p[0] >= 0.99]
        if len(ps) == 1 and (not cnaes or ps[0][1]):
            return {"cnpj": ps[0][2]["cnpj"], "confianca": "média",
                    "motivo": "nome único na Região Metropolitana (endereço não confirmado)"}
        if len(ps) > 1:
            return {"cnpj": None, "motivo": f"{len(ps)} empresas com esse nome; falta endereço para escolher"}
    return {"cnpj": None, "motivo": "nenhum estabelecimento compatível na base da Receita"}


def descobrir(con, cfg: dict, hoje: dt.date | None = None, limite: int = 200) -> list[dict]:
    """Empresas dos CNAEs-alvo nas regiões prioritárias, direto da base da Receita."""
    hoje = hoje or dt.date.today()
    filtros = cfg["filtros"]
    cnaes = sorted({c for lista in cfg.get("cnaes_por_setor", {}).values() for c in lista})
    if not cnaes:
        raise ValueError("Defina cnaes_por_setor no config.yaml para descobrir pela Receita.")
    corte = (hoje - dt.timedelta(days=int(365.25 * filtros.get("anos_minimos_cnpj", 0)))).strftime("%Y%m%d")
    regioes = [normalizar(r) for r in cfg.get("regioes_prioritarias", [])]
    cidade = normalizar(cfg.get("cidade", "Rio de Janeiro"))
    portes = [k for k, v in PORTE.items() if v in filtros.get("portes", []) or v == "DEMAIS"]
    q = lambda n: ",".join("?" * n)
    linhas = con.execute(f"""
        SELECT e.*, m.razao, m.capital, m.porte,
               (SELECT COUNT(*) FROM estab x WHERE x.basico = e.basico) AS unidades
        FROM estab e JOIN empresa m USING(basico)
        WHERE e.cnae IN ({q(len(cnaes))})
          AND e.inicio <= ?
          AND m.porte IN ({q(len(portes))})
          AND m.capital <= ?
          AND ((e.municipio_norm = ? AND e.bairro_norm IN ({q(len(regioes))}))
               OR e.municipio_norm IN ({q(len(regioes))}))
        ORDER BY unidades DESC, m.capital DESC
    """, (*cnaes, corte, *portes, filtros.get("capital_social_maximo", 1e18),
          cidade, *regioes, *regioes)).fetchall()

    setor_por_cnae = {c: s for s, lista in cfg["cnaes_por_setor"].items() for c in lista}
    vistos, saida = set(), []
    for e in linhas:
        if e["basico"] in vistos:
            continue
        vistos.add(e["basico"])
        nome = (e["fantasia"] or e["razao"] or "").title()
        saida.append({
            "empresa": nome,
            "cnpj": e["cnpj"],
            "endereco": f"{e['logradouro']}, {e['numero'] or 's/n'} - {e['bairro']}, "
                        f"{e['municipio']} - RJ, {e['cep'][:5]}-{e['cep'][5:]}",
            "bairro": e["bairro"],
            "setor_busca": setor_por_cnae.get(e["cnae"], e["cnae"]),
            "unidades_receita": e["unidades"],
            "fonte": "Receita Federal (dados abertos)",
        })
        if len(saida) >= limite:
            break
    return saida
