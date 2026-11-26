"""Etapas 2 e 3: coleta, enriquecimento e pontuação dos leads."""
from __future__ import annotations

import csv
import datetime as dt
from collections import Counter
from urllib.parse import quote_plus

from . import cnpj as receita
from . import places
from .scoring import normalizar, pontuar
from .site import LeitorSite, dominio

NF = "não encontrado"

# Campos que a equipe preenche à mão (LinkedIn, Instagram e bibliotecas de anúncios
# não permitem coleta automatizada).
CAMPOS_MANUAIS = [
    "anuncios_meses",
    "vagas_gestao",
    "expansao_recente",
    "linkedin",
    "instagram",
    "decisor_manual",
    "cargo_manual",
    "observacoes_manuais",
]


def links_consulta_manual(lead: dict) -> dict:
    nome = quote_plus(lead.get("empresa") or lead.get("nome_fantasia") or "")
    links = {
        "link_meta_ads": (
            "https://www.facebook.com/ads/library/?active_status=active&ad_type=all"
            f"&country=BR&q={nome}&search_type=keyword_unordered"
        ),
        "link_linkedin": f"https://www.linkedin.com/search/results/companies/?keywords={nome}",
    }
    if lead.get("site"):
        links["link_google_ads"] = (
            f"https://adstransparency.google.com/?region=BR&domain={dominio(lead['site'])}"
        )
    else:
        links["link_google_ads"] = "https://adstransparency.google.com/?region=BR"
    return links


def sugerir_abordagem(lead: dict, servico: str) -> str:
    nome = lead.get("empresa") or lead.get("nome_fantasia") or "a empresa"
    unidades = max(lead.get("unidades_site") or 0, lead.get("unidades_maps") or 0)
    if unidades > 1:
        return (
            f"Com {unidades} unidades, manter o mesmo padrão em todas é o desafio; "
            f"{servico} ajuda a {nome} a crescer sem perder o controle."
        )
    if lead.get("vagas_gestao") or lead.get("vagas_gestao_site"):
        return (
            f"Vi que a {nome} está contratando para gestão; {servico} agora "
            "acelera a chegada de quem entra."
        )
    if (lead.get("anuncios_meses") or 0) > 3:
        return (
            f"A {nome} já investe em anúncios há meses; {servico} garante que "
            "a operação dê conta da demanda que eles trazem."
        )
    if (lead.get("avaliacoes") or 0) > 100:
        return (
            f"Com {lead['avaliacoes']} avaliações no Google, a {nome} tem demanda; "
            f"{servico} ajuda a manter a qualidade enquanto cresce."
        )
    return (
        f"A {nome} tem o perfil das empresas que a Ejota apoia com {servico}; "
        "topa uma conversa de 20 minutos?"
    )


def _nomes_batem(lead: dict) -> bool:
    ignorar = {"ltda", "me", "epp", "eireli", "sa", "s/a", "de", "da", "do", "e", "&"}
    a = set(normalizar(lead.get("empresa")).split()) - ignorar
    b = set(normalizar(f"{lead.get('razao_social')} {lead.get('nome_fantasia')}").split()) - ignorar
    return not a or bool(a & b)


def candidatos_places(cfg: dict, chave: str, http, log=print) -> list[dict]:
    vistos: dict[str, dict] = {}
    for setor in cfg["setores"]:
        for regiao in cfg["regioes_prioritarias"]:
            consulta = f"{setor} em {regiao}, {cfg.get('cidade', 'Rio de Janeiro')}"
            log(f"Buscando: {consulta}")
            for lugar in places.buscar(consulta, chave, http, cfg.get("max_resultados_por_busca", 20)):
                lugar["setor_busca"] = setor
                vistos.setdefault(lugar["place_id"], lugar)
    lista = list(vistos.values())
    # Mesmo nome em endereços diferentes = mais de uma unidade.
    contagem = Counter(normalizar(c["empresa"]) for c in lista)
    for c in lista:
        c["unidades_maps"] = contagem[normalizar(c["empresa"])]
    return lista


def candidatos_csv(caminho: str) -> list[dict]:
    with open(caminho, newline="", encoding="utf-8-sig") as f:
        linhas = list(csv.DictReader(f))
    numericos = {"nota": float, "avaliacoes": int, "unidades_maps": int}
    for linha in linhas:
        for campo, tipo in numericos.items():
            valor = (linha.get(campo) or "").replace(",", ".").strip()
            linha[campo] = tipo(float(valor)) if valor else None
    return linhas


def enriquecer(candidato: dict, cfg: dict, http, leitor: LeitorSite, hoje: dt.date) -> dict:
    data = hoje.strftime("%d/%m/%Y")
    lead = {campo: None for campo in CAMPOS_MANUAIS}
    lead.update(candidato)
    fontes = []
    if candidato.get("place_id"):
        fontes.append(f"Google Maps (Places API), {data}")
    elif candidato.get("fonte"):
        fontes.append(f"{candidato['fonte']}, {data}")
    pendencias = []

    analise = leitor.analisar(candidato.get("site") or "")
    if analise:
        lead.update(analise)
        if "erro_site" in analise:
            pendencias.append(analise["erro_site"])
        else:
            fontes.append(f"site {candidato['site']}, {data}")
    elif not candidato.get("site"):
        pendencias.append("site não encontrado")

    numero = receita.somente_digitos(candidato.get("cnpj") or "")
    if not numero and lead.get("cnpjs_site"):
        numero = lead["cnpjs_site"][0]
    lead["excluido"] = None
    if numero:
        dados = receita.buscar_cnpj(numero, http)
        if dados:
            lead.update(receita.interpretar(dados, hoje))
            fontes.append(f"Receita Federal (dados abertos via BrasilAPI), {data}")
            f = cfg["filtros"]
            lead["excluido"] = receita.motivo_exclusao(lead, f["portes"], f["anos_minimos_cnpj"])
            if not _nomes_batem(lead):
                pendencias.append("conferir se o CNPJ do site é mesmo desta empresa")
        else:
            pendencias.append("CNPJ não encontrado na Receita")
    else:
        pendencias.append("CNPJ não encontrado (procurar no rodapé do site ou em notas fiscais públicas)")

    for campo in ("cnpj", "razao_social", "decisor", "cargo", "porte", "data_abertura"):
        if not lead.get(campo):
            lead[campo] = NF

    lead["fontes"] = fontes
    lead["pendencias"] = pendencias
    lead.update(links_consulta_manual(lead))
    return lead


def calcular(lead: dict, cfg: dict) -> dict:
    pontos, cls, sinais, pendentes = pontuar(lead, cfg)
    lead["pontuacao"] = pontos
    lead["classe"] = cls
    lead["sinais"] = sinais
    lead["pendencias_manuais"] = pendentes
    lead["abordagem"] = sugerir_abordagem(lead, cfg.get("servico", "nosso serviço"))
    return lead


def coletar(cfg: dict, http, chave: str | None = None, entrada: str | None = None,
            limite: int | None = None, hoje: dt.date | None = None, log=print) -> list[dict]:
    hoje = hoje or dt.date.today()
    if entrada:
        candidatos = candidatos_csv(entrada)
    elif chave:
        candidatos = candidatos_places(cfg, chave, http, log)
    else:
        raise ValueError("Informe GOOGLE_MAPS_API_KEY ou um arquivo de entrada (--entrada).")
    if limite:
        candidatos = candidatos[:limite]

    leitor = LeitorSite(http)
    leads, raizes = [], set()
    for i, c in enumerate(candidatos, 1):
        log(f"[{i}/{len(candidatos)}] {c.get('empresa')}")
        lead = calcular(enriquecer(c, cfg, http, leitor, hoje), cfg)
        raiz = receita.somente_digitos(lead["cnpj"])[:8]
        if raiz and raiz in raizes:
            continue  # outra unidade de uma empresa já listada
        if raiz:
            raizes.add(raiz)
        leads.append(lead)
    leads.sort(key=lambda l: (l["excluido"] is not None, -l["pontuacao"]))
    return leads
