"""Pontuação de capacidade de investimento (0 a 100) e classe A/B/C."""
from __future__ import annotations

import unicodedata

PONTOS = {
    "anuncios": 25,
    "unidades": 20,
    "vagas_gestao": 15,
    "capital": 10,
    "ferramentas": 10,
    "avaliacoes": 10,
    "regiao": 10,
}


def normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    return sem_acento.lower().strip()


def em_regiao_prioritaria(lead: dict, regioes: list[str]) -> str | None:
    local = normalizar(
        " ".join(
            str(lead.get(c) or "")
            for c in ("bairro", "bairro_receita", "endereco", "municipio", "municipio_maps")
        )
    )
    for r in regioes:
        if normalizar(r) in local:
            return r
    return None


def classe(pontos: int) -> str:
    if pontos >= 70:
        return "A"
    if pontos >= 40:
        return "B"
    return "C"


def pontuar(lead: dict, cfg: dict) -> tuple[int, str, list[str], list[str]]:
    """Retorna (pontos, classe, sinais encontrados, pendências manuais)."""
    p = cfg["pontuacao"]
    pontos = 0
    sinais: list[str] = []
    pendentes: list[str] = []

    meses = lead.get("anuncios_meses")
    if meses is None:
        pendentes.append("anúncios ativos (Biblioteca da Meta / Google)")
    elif meses > 3:
        pontos += PONTOS["anuncios"]
        sinais.append(f"anúncios ativos há {meses:g} meses (+25)")
    elif meses > 0:
        sinais.append(f"anúncios ativos há {meses:g} meses (menos de 3, sem pontos)")

    unidades = max(lead.get("unidades_site") or 0, lead.get("unidades_maps") or 0)
    if unidades > 1 or lead.get("expansao_recente"):
        pontos += PONTOS["unidades"]
        sinais.append(f"{unidades} unidades (+20)" if unidades > 1 else "expansão recente (+20)")

    if lead.get("vagas_gestao") or lead.get("vagas_gestao_site"):
        pontos += PONTOS["vagas_gestao"]
        sinais.append("vagas de gestão abertas (+15)")
    elif lead.get("pagina_vagas"):
        sinais.append("tem página de vagas (sem vaga de gestão confirmada)")

    capital = lead.get("capital_social") or 0
    if capital > p["capital_social_minimo"]:
        pontos += PONTOS["capital"]
        sinais.append(f"capital social R$ {capital:,.0f} (+10)".replace(",", "."))

    ferramentas = lead.get("ferramentas_pagas") or []
    if ferramentas:
        pontos += PONTOS["ferramentas"]
        sinais.append(f"ferramentas pagas: {', '.join(ferramentas)} (+10)")

    nota, aval = lead.get("nota"), lead.get("avaliacoes")
    if nota is not None and aval is not None:
        if aval > p["avaliacoes_minimas"] and nota > p["nota_minima"]:
            pontos += PONTOS["avaliacoes"]
            sinais.append(f"{aval} avaliações, nota {nota} (+10)")

    regiao = em_regiao_prioritaria(lead, cfg.get("regioes_prioritarias", []))
    if regiao:
        pontos += PONTOS["regiao"]
        sinais.append(f"região prioritária: {regiao} (+10)")

    if lead.get("pixel_meta"):
        sinais.append("pixel da Meta instalado")
    if lead.get("tag_google_ads"):
        sinais.append("tag do Google Ads instalada")

    return pontos, classe(pontos), sinais, pendentes
