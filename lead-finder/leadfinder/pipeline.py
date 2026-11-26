"""Etapas 2 e 3: coleta, enriquecimento e pontuação dos leads."""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
from collections import Counter
from pathlib import Path
from urllib.parse import quote_plus

from . import cnpj as receita
from . import places
from . import receita_base
from .scoring import normalizar, pontuar, tokens_nome
from .site import LeitorSite, dominio

NF = "não encontrado"
CEP_RE = re.compile(r"\b\d{5}-?\d{3}\b")

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
    unidades = max(lead.get("unidades_site") or 0, lead.get("unidades_maps") or 0,
                   lead.get("unidades_receita") or 0)
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
    """Mesmo critério do cruzamento com a Receita: palavras distintivas ou sigla."""
    cand = {"fantasia": lead.get("nome_fantasia") or "", "razao": lead.get("razao_social") or ""}
    sim = receita_base._similaridade(lead.get("empresa") or "", cand)
    return sim is None or sim > 0


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


def ler_csv(caminho: str) -> list[dict]:
    """Lê CSV salvo pelo Excel em português (';' e cp1252) ou em UTF-8 com ','."""
    try:
        with open(caminho, encoding="utf-8-sig") as f:
            conteudo = f.read()
    except UnicodeDecodeError:
        with open(caminho, encoding="cp1252") as f:
            conteudo = f.read()
    cabecalho = conteudo.split("\n", 1)[0]
    separador = ";" if cabecalho.count(";") > cabecalho.count(",") else ","
    return list(csv.DictReader(io.StringIO(conteudo), delimiter=separador))


def candidatos_csv(caminho: str) -> list[dict]:
    linhas = ler_csv(caminho)
    numericos = {"nota": float, "avaliacoes": int, "unidades_maps": int, "unidades_receita": int}
    for linha in linhas:
        for campo, tipo in numericos.items():
            valor = (linha.get(campo) or "").replace(",", ".").strip()
            linha[campo] = tipo(float(valor)) if valor else None
    return linhas


def _cnaes_do_setor(cfg: dict, setor: str | None) -> list[str]:
    por_setor = cfg.get("cnaes_por_setor") or {}
    if setor in por_setor:
        return por_setor[setor]
    return sorted({c for lista in por_setor.values() for c in lista})


def completar_com_maps(candidato: dict, chave: str, http) -> dict:
    """Para empresas vindas da Receita: busca site, telefone e avaliações no Google Maps."""
    achados = places.buscar(f"{candidato['empresa']} {candidato['endereco']}", chave, http, maximo=3)
    for lugar in achados:
        mesmo_nome = tokens_nome(lugar["empresa"]) & tokens_nome(candidato["empresa"])
        mesmo_cep = receita_base.extrair_endereco(lugar["endereco"])[0] == \
            receita_base.extrair_endereco(candidato["endereco"])[0]
        if mesmo_nome and mesmo_cep:
            for campo in ("place_id", "site", "telefone", "nota", "avaliacoes"):
                candidato[campo] = lugar[campo]
            break
    return candidato


def enriquecer(candidato: dict, cfg: dict, http, leitor: LeitorSite, hoje: dt.date,
               base=None) -> dict:
    data = hoje.strftime("%d/%m/%Y")
    lead = {campo: None for campo in CAMPOS_MANUAIS}
    lead.update(candidato)
    fontes = []
    if candidato.get("place_id"):
        fontes.append(f"Google Maps (Places API), {data}")
    elif candidato.get("fonte") and not candidato["fonte"].startswith("Receita Federal"):
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
    if not numero and base is not None:
        achado = receita_base.casar(base, candidato.get("empresa") or "", candidato.get("endereco") or "",
                                    _cnaes_do_setor(cfg, candidato.get("setor_busca")))
        if achado["cnpj"]:
            numero = achado["cnpj"]
            lead["cnpj_origem"] = f"cruzamento com a base da Receita, confiança {achado['confianca']}"
            if achado["confianca"] != "alta":
                pendencias.append(f"CNPJ por cruzamento com confiança média ({achado['motivo']}): conferir")
        else:
            pendencias.append(f"cruzamento com a Receita: {achado['motivo']}")
    lead["excluido"] = None
    if numero:
        local = receita_base.interpretar_local(base, numero, hoje) if base is not None else None
        dados = None
        if local is None:
            try:
                dados = receita.buscar_cnpj(numero, http)
            except RuntimeError as erro:
                pendencias.append(f"{erro}: rodar de novo mais tarde")
        if local or dados:
            if local:
                lead.update(local)
                fontes.append(f"Receita Federal (dados abertos, competência "
                              f"{receita_base.competencia(base)}), {data}")
            else:
                lead.update(receita.interpretar(dados, hoje))
                fontes.append(f"Receita Federal (dados abertos via BrasilAPI), {data}")
            lead["excluido"] = receita.motivo_exclusao(lead, cfg["filtros"])
            alerta = receita.alerta_porte(lead)
            if alerta and not lead["excluido"]:
                pendencias.append(alerta)
            if not _nomes_batem(lead):
                pendencias.append("nome na Receita não bate com o nome da empresa: conferir o CNPJ")
            cep_maps = CEP_RE.search(lead.get("endereco") or "")
            cep_receita = lead.get("cep_receita") or ""
            if cep_maps and cep_receita and receita.somente_digitos(cep_maps.group())[:5] != cep_receita[:5]:
                pendencias.append(
                    f"CEP da Receita ({cep_receita}) difere do endereço ({cep_maps.group()}): "
                    "conferir se é filial ou outra empresa")
        elif not pendencias or "BrasilAPI" not in pendencias[-1]:
            pendencias.append("CNPJ não encontrado na Receita")
    elif base is None:
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


def abrir_base(cfg: dict):
    caminho = cfg.get("base_receita")
    if caminho and Path(caminho).exists():
        return receita_base.conectar(caminho)
    return None


def coletar(cfg: dict, http, chave: str | None = None, entrada: str | None = None,
            limite: int | None = None, hoje: dt.date | None = None, log=print,
            fonte: str = "maps", base=None) -> list[dict]:
    hoje = hoje or dt.date.today()
    base = base if base is not None else abrir_base(cfg)
    if entrada:
        candidatos = candidatos_csv(entrada)
    elif fonte == "receita":
        if base is None:
            raise ValueError("Base da Receita não encontrada: rode 'python -m leadfinder base atualizar'.")
        candidatos = receita_base.descobrir(base, cfg, hoje, limite or 200)
        if chave:
            for c in candidatos:
                completar_com_maps(c, chave, http)
    elif chave:
        candidatos = candidatos_places(cfg, chave, http, log)
    else:
        raise ValueError("Informe GOOGLE_MAPS_API_KEY, --fonte receita ou --entrada.")
    if limite:
        candidatos = candidatos[:limite]

    leitor = LeitorSite(http)
    leads, raizes = [], set()
    for i, c in enumerate(candidatos, 1):
        log(f"[{i}/{len(candidatos)}] {c.get('empresa')}")
        lead = calcular(enriquecer(c, cfg, http, leitor, hoje, base), cfg)
        raiz = receita.somente_digitos(lead["cnpj"])[:8]
        if raiz and raiz in raizes:
            continue  # outra unidade de uma empresa já listada
        if raiz:
            raizes.add(raiz)
        leads.append(lead)
    leads.sort(key=lambda l: (l["excluido"] is not None, -l["pontuacao"]))
    return leads
