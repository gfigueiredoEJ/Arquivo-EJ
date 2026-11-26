import datetime as dt
import json

import pytest

from leadfinder import cnpj, pipeline, report, scoring, site
from leadfinder.cli import carregar_config

HOJE = dt.date(2026, 11, 26)
CFG = carregar_config("config.yaml")


class Resp:
    def __init__(self, status=200, text="", headers=None):
        self.status_code = status
        self.text = text
        self.headers = headers or {"content-type": "text/html"}

    def json(self):
        return json.loads(self.text)


class FakeHttp:
    def __init__(self, rotas):
        self.rotas = rotas
        self.pedidos = []

    def get(self, url, **kw):
        self.pedidos.append(url)
        return self.rotas.get(url, Resp(404))

    def post(self, url, **kw):
        self.pedidos.append(url)
        return self.rotas.get(url, Resp(404))


# CNPJ válido gerado para teste (dígitos verificadores corretos).
CNPJ_TESTE = "11222333000181"

RECEITA = {
    "cnpj": CNPJ_TESTE,
    "razao_social": "CLINICA SORRISO CARIOCA LTDA",
    "nome_fantasia": "SORRISO CARIOCA",
    "cnae_fiscal": 8630504,
    "cnae_fiscal_descricao": "Atividade odontológica",
    "codigo_porte": 3,
    "capital_social": 250000,
    "data_inicio_atividade": "2015-03-10",
    "descricao_situacao_cadastral": "ATIVA",
    "bairro": "BARRA DA TIJUCA",
    "municipio": "RIO DE JANEIRO",
    "email": "fulano.pessoal@gmail.com",
    "ddd_telefone_1": "21999999999",
    "qsa": [
        {"nome_socio": "MARIA DA SILVA", "qualificacao_socio": "Sócio",
         "cnpj_cpf_do_socio": "***123456**", "faixa_etaria": "Entre 41 a 50 anos"},
        {"nome_socio": "JOAO DE SOUZA", "qualificacao_socio": "Sócio-Administrador",
         "cnpj_cpf_do_socio": "***654321**", "faixa_etaria": "Entre 51 a 60 anos"},
    ],
}

HOME = f"""
<html><head>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script>
<script>fbq('init', '123');</script>
<script src="https://www.googletagmanager.com/gtag/js?id=AW-123456789"></script>
<script src="https://d335luupugsy2.cloudfront.net/js/loader-scripts/abc.js"></script>
</head><body>
<a href="/trabalhe-conosco">Trabalhe conosco</a>
<a href="/admin">admin</a>
<p>Somos 3 unidades no Rio. Fale com contato@sorrisocarioca.com.br ou dono@gmail.com</p>
<footer>Clínica Sorriso Carioca Ltda - CNPJ 11.222.333/0001-81</footer>
</body></html>
"""
VAGAS = "<html><body><h1>Vagas</h1><p>Gerente administrativo(a)</p></body></html>"
ROBOTS = "User-agent: *\nDisallow: /admin\n"


def rotas_site():
    base = "https://www.sorrisocarioca.com.br"
    return {
        base + "/robots.txt": Resp(text=ROBOTS, headers={"content-type": "text/plain"}),
        base: Resp(text=HOME),
        base + "/trabalhe-conosco": Resp(text=VAGAS),
        cnpj.BRASILAPI_URL.format(cnpj=CNPJ_TESTE): Resp(text=json.dumps(RECEITA)),
    }


def test_validacao_cnpj():
    assert cnpj.cnpj_valido("11.222.333/0001-81")
    assert not cnpj.cnpj_valido("11.222.333/0001-82")
    assert not cnpj.cnpj_valido("11111111111111")
    assert cnpj.encontrar_cnpjs("CNPJ 11.222.333/0001-81 e 11.222.333/0001-82") == [CNPJ_TESTE]


def test_interpretar_descarta_dados_pessoais_e_escolhe_administrador():
    info = cnpj.interpretar(RECEITA, HOJE)
    assert info["decisor"] == "Joao de Souza"
    assert info["cargo"] == "Sócio-Administrador"
    assert info["porte"] == "EPP"
    assert info["anos_cnpj"] > 11
    texto = json.dumps(info, ensure_ascii=False)
    for proibido in ("gmail", "999999999", "***", "faixa", "Entre 41"):
        assert proibido not in texto


def test_motivo_exclusao():
    info = cnpj.interpretar(RECEITA, HOJE)
    assert cnpj.motivo_exclusao(info, ["ME", "EPP"], 2) is None
    assert cnpj.motivo_exclusao({**info, "porte": "DEMAIS"}, ["ME", "EPP"], 2) == "porte DEMAIS"
    assert "anos" in cnpj.motivo_exclusao({**info, "anos_cnpj": 1.0}, ["ME", "EPP"], 2)
    assert "baixada" in cnpj.motivo_exclusao({**info, "situacao": "BAIXADA"}, ["ME", "EPP"], 2)


def test_analise_site_detecta_sinais_e_respeita_robots():
    http = FakeHttp(rotas_site())
    r = site.LeitorSite(http).analisar("https://www.sorrisocarioca.com.br")
    assert r["pixel_meta"] and r["tag_google_ads"]
    assert r["ferramentas_pagas"] == ["RD Station"]
    assert r["vagas_gestao_site"] is True
    assert r["unidades_site"] == 3
    assert r["email_corporativo"] == "contato@sorrisocarioca.com.br"  # gmail ignorado
    assert r["cnpjs_site"] == [CNPJ_TESTE]
    assert not any(u.endswith("/admin") for u in http.pedidos)


def test_site_bloqueado_por_robots():
    base = "https://bloqueado.com.br"
    http = FakeHttp({base + "/robots.txt": Resp(text="User-agent: *\nDisallow: /")})
    r = site.LeitorSite(http).analisar(base)
    assert "robots" in r["erro_site"]
    assert http.pedidos == [base + "/robots.txt"]


def test_pontuacao_e_classes():
    lead = {
        "anuncios_meses": 6, "unidades_site": 3, "vagas_gestao_site": True,
        "capital_social": 250000, "ferramentas_pagas": ["RD Station"],
        "nota": 4.7, "avaliacoes": 320, "bairro": "Barra da Tijuca",
    }
    pontos, cls, sinais, pend = scoring.pontuar(lead, CFG)
    assert (pontos, cls, pend) == (100, "A", [])
    pontos, cls, _, pend = scoring.pontuar({"bairro": "Bangu"}, CFG)
    assert (pontos, cls) == (0, "C")
    assert pend  # anúncios ficam como verificação manual
    assert scoring.classe(70) == "A" and scoring.classe(69) == "B" and scoring.classe(39) == "C"


def test_regiao_ignora_acentos():
    assert scoring.em_regiao_prioritaria({"municipio": "NITEROI"}, ["Niterói"]) == "Niterói"


def test_fluxo_completo_e_repontuacao(tmp_path):
    entrada = tmp_path / "empresas.csv"
    entrada.write_text(
        "empresa,site,bairro,telefone,nota,avaliacoes\n"
        "Sorriso Carioca,https://www.sorrisocarioca.com.br,Barra da Tijuca,(21) 3333-4444,4.8,210\n",
        encoding="utf-8",
    )
    leads = pipeline.coletar(CFG, FakeHttp(rotas_site()), entrada=str(entrada),
                             hoje=HOJE, log=lambda *_: None)
    assert len(leads) == 1
    lead = leads[0]
    # unidades 20 + vagas 15 + capital 10 + ferramentas 10 + avaliações 10 + região 10
    assert lead["pontuacao"] == 75 and lead["classe"] == "A"
    assert lead["decisor"] == "Joao de Souza"
    assert any("Receita Federal" in f for f in lead["fontes"])
    assert lead["pendencias_manuais"]

    arquivos = report.salvar(leads, str(tmp_path / "saida"))
    md = arquivos["markdown"].read_text(encoding="utf-8")
    assert "Sorriso Carioca" in md and "11.222.333/0001-81" in md
    assert "gmail" not in md

    # A equipe preenche as colunas manuais e repontua.
    linhas = arquivos["csv"].read_text(encoding="utf-8-sig").splitlines()
    cab = linhas[0].split(",")
    assert "anuncios_meses" in cab
    recarregados = report.carregar_csv(str(arquivos["csv"]))
    recarregados[0]["anuncios_meses"] = 5
    novo = pipeline.calcular(recarregados[0], CFG)
    assert novo["pontuacao"] == 100


def test_sem_cnpj_vira_nao_encontrado(tmp_path):
    entrada = tmp_path / "e.csv"
    entrada.write_text("empresa,site\nPadaria X,\n", encoding="utf-8")
    leads = pipeline.coletar(CFG, FakeHttp({}), entrada=str(entrada), hoje=HOJE, log=lambda *_: None)
    assert leads[0]["cnpj"] == "não encontrado"
    assert leads[0]["decisor"] == "não encontrado"


def test_places_converte_resposta():
    from leadfinder import places
    resposta = {"places": [{
        "id": "abc", "displayName": {"text": "Sorriso Carioca"},
        "formattedAddress": "Av. das Américas, 500 - Barra da Tijuca, Rio de Janeiro - RJ",
        "addressComponents": [
            {"longText": "Barra da Tijuca", "types": ["sublocality_level_1", "sublocality"]},
            {"longText": "Rio de Janeiro", "types": ["administrative_area_level_2"]},
        ],
        "nationalPhoneNumber": "(21) 3333-4444", "websiteUri": "https://sorriso.com.br",
        "rating": 4.8, "userRatingCount": 210, "businessStatus": "OPERATIONAL",
    }]}
    http = FakeHttp({places.URL: Resp(text=json.dumps(resposta))})
    r = places.buscar("clínica em Barra", "chave", http)
    assert r[0]["bairro"] == "Barra da Tijuca" and r[0]["avaliacoes"] == 210
    with pytest.raises(RuntimeError):
        places.buscar("x", "chave", FakeHttp({}))
