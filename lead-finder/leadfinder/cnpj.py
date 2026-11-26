"""Dados abertos de CNPJ (Receita Federal) via BrasilAPI.

Somente dados da empresa e nome/qualificação dos sócios são mantidos.
CPF (mesmo mascarado), faixa etária, e-mail e telefone do cadastro da Receita
são descartados: podem ser pessoais e não entram no relatório (LGPD).
"""
from __future__ import annotations

import datetime as dt
import re
import time
import unicodedata

BRASILAPI_URL = "https://brasilapi.com.br/api/cnpj/v1/{cnpj}"

CNPJ_RE = re.compile(r"(?<!\d)\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}(?!\d)")

PORTE_POR_CODIGO = {1: "ME", 3: "EPP", 5: "DEMAIS"}

# Ordem de preferência para escolher o tomador de decisão no quadro societário.
PRIORIDADE_DECISOR = [
    "sócio-administrador",
    "administrador",
    "presidente",
    "diretor",
    "sócio",
]


def somente_digitos(texto: str) -> str:
    return re.sub(r"\D", "", texto or "")


def cnpj_valido(cnpj: str) -> bool:
    c = somente_digitos(cnpj)
    if len(c) != 14 or c == c[0] * 14:
        return False

    def digito(base: str, pesos: list[int]) -> str:
        resto = sum(int(n) * p for n, p in zip(base, pesos)) % 11
        return "0" if resto < 2 else str(11 - resto)

    pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    d1 = digito(c[:12], pesos1)
    d2 = digito(c[:12] + d1, [6] + pesos1)
    return c[12:] == d1 + d2


def encontrar_cnpjs(texto: str) -> list[str]:
    """CNPJs válidos no texto, sem repetição, na ordem em que aparecem."""
    vistos: list[str] = []
    for bruto in CNPJ_RE.findall(texto or ""):
        c = somente_digitos(bruto)
        if cnpj_valido(c) and c not in vistos:
            vistos.append(c)
    return vistos


def formatar_cnpj(cnpj: str) -> str:
    c = somente_digitos(cnpj)
    if len(c) != 14:
        return cnpj
    return f"{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}"


def buscar_cnpj(cnpj: str, http, tentativas: int = 3, espera: float = 5.0) -> dict | None:
    """Consulta a BrasilAPI, tentando de novo em limite de requisições (429) ou erro do servidor."""
    url = BRASILAPI_URL.format(cnpj=somente_digitos(cnpj))
    for i in range(tentativas):
        resp = http.get(url)
        if resp is not None and resp.status_code == 200:
            return resp.json()
        if resp is not None and resp.status_code not in (429, 500, 502, 503, 504):
            return None  # 404 etc.: CNPJ realmente não encontrado
        if i < tentativas - 1:
            time.sleep(espera * (i + 1))
    raise RuntimeError(f"BrasilAPI indisponível para o CNPJ {formatar_cnpj(cnpj)}")


def _titulo(nome: str) -> str:
    minusculas = {"de", "da", "do", "das", "dos", "e"}
    partes = (nome or "").lower().split()
    return " ".join(p if p in minusculas else p.capitalize() for p in partes)


def escolher_decisor(qsa: list[dict]) -> tuple[str, str]:
    socios = [
        (s.get("nome_socio") or "", (s.get("qualificacao_socio") or "").strip())
        for s in qsa or []
        if s.get("nome_socio")
    ]
    for alvo in PRIORIDADE_DECISOR:
        for nome, qualif in socios:
            if alvo in qualif.lower():
                return _titulo(nome), qualif
    if socios:
        return _titulo(socios[0][0]), socios[0][1] or "não encontrado"
    return "não encontrado", "não encontrado"


def interpretar(dados: dict, hoje: dt.date | None = None) -> dict:
    hoje = hoje or dt.date.today()
    abertura = dados.get("data_inicio_atividade")
    anos = None
    if abertura:
        d = dt.date.fromisoformat(abertura)
        anos = round((hoje - d).days / 365.25, 1)
    decisor, cargo = escolher_decisor(dados.get("qsa") or [])
    return {
        "cnpj": formatar_cnpj(dados.get("cnpj", "")),
        "razao_social": dados.get("razao_social") or "não encontrado",
        "nome_fantasia": dados.get("nome_fantasia") or "",
        "cnae": str(dados.get("cnae_fiscal") or ""),
        "cnae_descricao": dados.get("cnae_fiscal_descricao") or "",
        "porte": PORTE_POR_CODIGO.get(dados.get("codigo_porte"), "não informado"),
        "capital_social": float(dados.get("capital_social") or 0),
        "data_abertura": abertura or "não encontrado",
        "anos_cnpj": anos,
        "situacao": dados.get("descricao_situacao_cadastral") or "",
        "bairro_receita": _titulo(dados.get("bairro") or ""),
        "municipio": _titulo(dados.get("municipio") or ""),
        "cep_receita": somente_digitos(dados.get("cep") or ""),
        "matriz_filial": dados.get("descricao_identificador_matriz_filial") or "",
        "decisor": decisor,
        "cargo": cargo,
    }


def _sem_acento(texto: str) -> str:
    return unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode().lower()


def motivo_exclusao(info: dict, filtros: dict) -> str | None:
    """Motivo para descartar a empresa pelo perfil, ou None se ela passa.

    Porte "DEMAIS" na Receita não exclui sozinho: significa só que a empresa não
    declarou enquadramento como ME/EPP. O teto de capital social pega as grandes.
    """
    if info["situacao"] and info["situacao"].upper() != "ATIVA":
        return f"CNPJ {info['situacao'].lower()}"
    aceitos = {_sem_acento(m) for m in filtros.get("municipios_aceitos", [])}
    if aceitos and info.get("municipio") and _sem_acento(info["municipio"]) not in aceitos:
        return f"fora da Região Metropolitana do Rio ({info['municipio']})"
    teto = filtros.get("capital_social_maximo")
    if teto and info["capital_social"] > teto:
        return f"capital social acima de R$ {teto:,.0f}".replace(",", ".")
    portes = filtros.get("portes", ["ME", "EPP"])
    if info["porte"] not in portes and info["porte"] != "DEMAIS":
        return f"porte {info['porte']}"
    anos = filtros.get("anos_minimos_cnpj", 0)
    if info["anos_cnpj"] is not None and info["anos_cnpj"] < anos:
        return f"CNPJ com {info['anos_cnpj']} anos"
    return None


def alerta_porte(info: dict) -> str | None:
    if info.get("porte") == "DEMAIS":
        return "porte DEMAIS na Receita (sem enquadramento ME/EPP): conferir nº de funcionários"
    return None
