"""Análise do site oficial: CNPJ no rodapé, tags de anúncio, ferramentas pagas,
página de vagas, número de unidades e e-mail corporativo.

Respeita robots.txt e visita no máximo algumas páginas por site.
"""
from __future__ import annotations

import html
import re
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

from .cnpj import encontrar_cnpjs

FERRAMENTAS_PAGAS = {
    "RD Station": ["d335luupugsy2.cloudfront.net", "rdstation.com"],
    "HubSpot": ["js.hs-scripts.com", "js.hsforms.net"],
    "Salesforce/Pardot": ["pardot.com", "force.com"],
    "ActiveCampaign": ["trackcmp.net", "activehosted.com"],
    "Zendesk": ["zdassets.com", "zendesk.com/embeddable"],
    "Intercom": ["widget.intercom.io"],
    "JivoChat": ["code.jivosite.com", "code.jivo.ru"],
    "Octadesk": ["octadesk.services", "octadesk.com"],
    "Blip": ["blip.ai", "take.net"],
    "Kommo": ["kommo.com"],
    "Zenvia": ["zenvia.com"],
    "Doctoralia": ["doctoralia.com.br"],
    "Feegow": ["feegow.com"],
    "iClinic": ["iclinic.com.br"],
    "Calendly": ["calendly.com"],
    "Hotjar": ["static.hotjar.com"],
}

META_PIXEL = ["connect.facebook.net/en_us/fbevents.js", "fbq('init'", 'fbq("init"']
GOOGLE_ADS_RE = re.compile(r"AW-\d{6,}|googleadservices\.com")

PAGINAS_EXTRAS_RE = re.compile(
    r"/(?:contato|fale-conosco|trabalhe|carreira|vagas|unidades|onde-estamos|sobre|quem-somos)",
    re.I,
)
VAGAS_RE = re.compile(r"trabalhe[\s-]conosco|carreiras?|vagas", re.I)
# "Diretor" fica de fora: sites de clínica trazem "Diretor técnico" no rodapé por exigência legal.
GESTAO_RE = re.compile(r"\b(gerente|coordenador[a]?|supervisor[a]?|gestor[a]?)\b", re.I)
# "12 clínicas parceiras" ou "lojas credenciadas" não são unidades próprias.
UNIDADES_RE = re.compile(
    r"\b(\d{1,3})\s+(?:unidades|lojas|filiais|clínicas|clinicas)\b"
    r"(?!\s+(?:parceir|credenciad|conveniad|atendid|cliente))",
    re.I,
)
# Ordem de visita das páginas internas: as que geram pontos primeiro.
PRIORIDADE_PAGINAS = [VAGAS_RE, re.compile(r"unidades|onde-estamos", re.I)]
NOSSAS_UNIDADES_RE = re.compile(r"nossas\s+(?:unidades|lojas|clínicas|clinicas)", re.I)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
HREF_RE = re.compile(r"""href\s*=\s*["']([^"'#]+)["']""", re.I)
TAG_RE = re.compile(r"<script.*?</script>|<style.*?</style>|<[^>]+>", re.I | re.S)

EMAILS_DE_FUNCAO = {"contato", "atendimento", "comercial", "financeiro", "sac", "adm",
                    "administrativo", "administracao", "secretaria", "recepcao", "agendamento",
                    "faleconosco", "info", "diretoria", "rh", "vendas", "marketing", "ouvidoria"}
PROVEDORES_GRATUITOS = {"gmail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com",
                        "yahoo.com.br", "bol.com.br", "uol.com.br", "icloud.com", "terra.com.br",
                        "ig.com.br", "globo.com", "msn.com", "protonmail.com"}

USER_AGENT = "EjotaLeadFinder/0.1 (+prospeccao B2B, dados publicos)"
MAX_PAGINAS = 4


def texto_visivel(pagina: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", pagina)))


def dominio(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def links_internos(pagina: str, base: str) -> list[str]:
    host = dominio(base)
    links = []
    for href in HREF_RE.findall(pagina):
        url = urljoin(base, href)
        mesma = {url, url.rstrip("/"), url.rstrip("/") + "/"}
        if dominio(url) == host and PAGINAS_EXTRAS_RE.search(url) and not mesma & set(links):
            links.append(url)

    def prioridade(url: str) -> int:
        for i, padrao in enumerate(PRIORIDADE_PAGINAS):
            if padrao.search(url):
                return i
        return len(PRIORIDADE_PAGINAS)

    return sorted(links, key=prioridade)


def analisar_html(paginas: dict[str, str], site: str) -> dict:
    """Extrai sinais de um conjunto de páginas {url: html} do mesmo site."""
    bruto = "\n".join(paginas.values())
    bruto_lower = bruto.lower()
    texto = texto_visivel(bruto)
    host = dominio(site)

    ferramentas = sorted(
        nome
        for nome, padroes in FERRAMENTAS_PAGAS.items()
        if any(p in bruto_lower for p in padroes)
    )

    paginas_vagas = [u for u in paginas if VAGAS_RE.search(u)]
    tem_vagas = bool(paginas_vagas) or bool(VAGAS_RE.search(texto))
    texto_vagas = " ".join(texto_visivel(paginas[u]) for u in paginas_vagas)
    vagas_gestao = bool(paginas_vagas) and bool(GESTAO_RE.search(texto_vagas))

    numeros = [int(n) for n in UNIDADES_RE.findall(texto) if 1 < int(n) < 500]
    unidades = max(numeros) if numeros else (2 if NOSSAS_UNIDADES_RE.search(texto) else None)

    encontrados = {e.lower() for e in EMAIL_RE.findall(texto)}
    # 1º: e-mail no domínio do site; 2º: e-mail de função (contato@, atendimento@...) em
    # domínio próprio da empresa. Nunca provedor gratuito: pode ser pessoal.
    emails = sorted(e for e in encontrados if host and e.endswith("@" + host))
    if not emails:
        emails = sorted(e for e in encontrados
                        if e.split("@")[0] in EMAILS_DE_FUNCAO
                        and e.split("@")[1] not in PROVEDORES_GRATUITOS)

    return {
        "cnpjs_site": encontrar_cnpjs(texto),
        "pixel_meta": any(p in bruto_lower for p in META_PIXEL),
        "tag_google_ads": bool(GOOGLE_ADS_RE.search(bruto)),
        "ferramentas_pagas": ferramentas,
        "pagina_vagas": tem_vagas,
        "vagas_gestao_site": vagas_gestao,
        "unidades_site": unidades,
        "email_corporativo": emails[0] if emails else "",
        "paginas_visitadas": list(paginas),
    }


class LeitorSite:
    def __init__(self, http):
        self.http = http
        self._robots: dict[str, RobotFileParser | None] = {}

    def _permitido(self, url: str) -> bool:
        partes = urlparse(url)
        raiz = f"{partes.scheme}://{partes.netloc}"
        if raiz not in self._robots:
            rp = RobotFileParser()
            resp = self.http.get(raiz + "/robots.txt")
            if resp is not None and resp.status_code == 200:
                rp.parse(resp.text.splitlines())
                self._robots[raiz] = rp
            elif resp is not None and resp.status_code in (401, 403):
                rp.disallow_all = True  # convenção do robots.txt: acesso negado = nada liberado
                self._robots[raiz] = rp
            else:
                self._robots[raiz] = None  # sem robots.txt: acesso liberado
        rp = self._robots[raiz]
        return rp is None or rp.can_fetch(USER_AGENT, url)

    def _baixar(self, url: str) -> str | None:
        if not self._permitido(url):
            return None
        resp = self.http.get(url)
        if resp is None or resp.status_code != 200:
            return None
        if "html" not in resp.headers.get("content-type", "html"):
            return None
        return resp.text

    def analisar(self, site: str) -> dict | None:
        if not site:
            return None
        if not site.startswith("http"):
            site = "https://" + site
        inicial = self._baixar(site)
        if inicial is None:
            return {"erro_site": "site inacessível ou bloqueado por robots.txt"}
        paginas = {site: inicial}
        for url in links_internos(inicial, site)[: MAX_PAGINAS - 1]:
            conteudo = self._baixar(url)
            if conteudo:
                paginas[url] = conteudo
        return analisar_html(paginas, site)
