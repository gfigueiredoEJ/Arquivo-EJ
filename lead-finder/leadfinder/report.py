"""Saída: tabela final (Markdown e Excel) e CSV completo para revisão manual."""
from __future__ import annotations

import csv
import re
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font

from .pipeline import CAMPOS_MANUAIS, NF, ler_csv

COLUNAS_FINAIS = [
    "Empresa", "CNPJ", "Setor", "Bairro", "Site", "Decisor", "Cargo",
    "Contato corporativo", "Sinais encontrados", "Pontuação", "Classe",
    "Fontes", "Sugestão de abordagem",
]

LISTAS = {"ferramentas_pagas", "fontes", "pendencias", "sinais", "pendencias_manuais",
          "cnpjs_site", "paginas_visitadas"}

CAMPOS_COMPLETOS = [
    "classe", "pontuacao", "excluido", "empresa", "razao_social", "nome_fantasia", "cnpj",
    "cnae", "cnae_descricao", "porte", "capital_social", "data_abertura", "anos_cnpj",
    "situacao", "setor_busca", "endereco", "bairro", "bairro_receita", "municipio",
    "municipio_maps", "cep_receita", "telefone", "email_corporativo", "site", "nota", "avaliacoes",
    "unidades_maps", "unidades_site", "pixel_meta", "tag_google_ads", "ferramentas_pagas",
    "pagina_vagas", "vagas_gestao_site", "decisor", "cargo", *CAMPOS_MANUAIS,
    "sinais", "pendencias", "pendencias_manuais", "abordagem", "fontes",
    "link_meta_ads", "link_google_ads", "link_linkedin", "place_id", "cnpjs_site",
    "paginas_visitadas",
]


def linha_final(lead: dict) -> dict:
    contatos = [c for c in (lead.get("telefone"), lead.get("email_corporativo")) if c]
    sinais = list(lead.get("sinais") or [])
    if lead.get("pendencias_manuais"):
        sinais.append("verificar manualmente: " + ", ".join(lead["pendencias_manuais"]))
    return {
        "Empresa": lead.get("empresa") or lead.get("nome_fantasia") or lead.get("razao_social"),
        "CNPJ": lead.get("cnpj") or NF,
        "Setor": lead.get("cnae_descricao") or lead.get("setor_busca") or NF,
        "Bairro": lead.get("bairro") or lead.get("bairro_receita") or NF,
        "Site": lead.get("site") or NF,
        "Decisor": lead.get("decisor_manual") or lead.get("decisor") or NF,
        "Cargo": lead.get("cargo_manual") or lead.get("cargo") or NF,
        "Contato corporativo": " / ".join(contatos) or NF,
        "Sinais encontrados": "; ".join(sinais) or "nenhum",
        "Pontuação": lead.get("pontuacao"),
        "Classe": lead.get("classe"),
        "Fontes": "; ".join(lead.get("fontes") or []),
        "Sugestão de abordagem": lead.get("abordagem", ""),
    }


def qualificados(leads: list[dict]) -> list[dict]:
    return [l for l in leads if not l.get("excluido") and l.get("classe") in ("A", "B")]


def _parece_formula(texto: str) -> bool:
    if texto[:1] in ("=", "@"):
        return True
    # "+55 21 3333-4444" é telefone, não fórmula
    return texto[:1] in ("+", "-") and not re.fullmatch(r"[+-][\d\s().-]+", texto)


def _celula(valor):
    if isinstance(valor, list):
        valor = "; ".join(str(v) for v in valor)
    if valor is None:
        return ""
    if isinstance(valor, str) and _parece_formula(valor):
        return "'" + valor  # dado vindo da web não pode virar fórmula no Excel
    return valor


def salvar(leads: list[dict], pasta: str) -> dict[str, Path]:
    destino = Path(pasta)
    destino.mkdir(parents=True, exist_ok=True)
    finais = [linha_final(l) for l in qualificados(leads)]

    md = destino / "leads.md"
    with md.open("w", encoding="utf-8") as f:
        f.write("| " + " | ".join(COLUNAS_FINAIS) + " |\n")
        f.write("|" + "---|" * len(COLUNAS_FINAIS) + "\n")
        for linha in finais:
            valores = [str(linha[c]).replace("|", "/").replace("\n", " ") for c in COLUNAS_FINAIS]
            f.write("| " + " | ".join(valores) + " |\n")

    completo = destino / "leads_completo.csv"
    with completo.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CAMPOS_COMPLETOS, extrasaction="ignore")
        w.writeheader()
        for lead in leads:
            w.writerow({c: _celula(lead.get(c)) for c in CAMPOS_COMPLETOS})

    xlsx = destino / "leads.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "Leads A e B"
    _planilha(ws, COLUNAS_FINAIS, [[_celula(l[c]) for c in COLUNAS_FINAIS] for l in finais])
    ws2 = wb.create_sheet("Todos (revisão)")
    _planilha(ws2, CAMPOS_COMPLETOS,
              [[_celula(l.get(c)) for c in CAMPOS_COMPLETOS] for l in leads])
    wb.save(xlsx)
    return {"markdown": md, "csv": completo, "xlsx": xlsx}


def _planilha(ws, cabecalho, linhas):
    ws.append(cabecalho)
    for c in ws[1]:
        c.font = Font(bold=True)
    for linha in linhas:
        ws.append(linha)
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 22
        for c in col[1:]:
            c.alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "B2"


def carregar_csv(caminho: str) -> list[dict]:
    """Lê o CSV completo (já com colunas manuais preenchidas) de volta para dicts."""
    numeros = {"pontuacao", "capital_social", "anos_cnpj", "nota", "avaliacoes",
               "unidades_maps", "unidades_site", "anuncios_meses"}
    booleanos = {"pixel_meta", "tag_google_ads", "pagina_vagas", "vagas_gestao_site",
                 "vagas_gestao", "expansao_recente"}
    leads = []
    for linha in ler_csv(caminho):
        lead: dict = {}
        for k, v in linha.items():
            v = (v or "").strip()
            if v.startswith("'"):
                v = v[1:]  # proteção anti-fórmula gravada por salvar()
            if k in numeros:
                if "," in v:  # formato brasileiro: 150.000,00
                    v = v.replace(".", "").replace(",", ".")
                lead[k] = float(v) if v else None
                if lead[k] is not None and lead[k].is_integer() and k != "capital_social":
                    lead[k] = int(lead[k])
            elif k in booleanos:
                lead[k] = (v.lower() in {"true", "sim", "s", "1", "x", "yes"}) if v else None
            elif k in LISTAS:
                lead[k] = [p.strip() for p in v.split(";") if p.strip()]
            else:
                lead[k] = v or None
        leads.append(lead)
    return leads
