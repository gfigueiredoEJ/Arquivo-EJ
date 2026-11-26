"""Testes do cruzamento com os dados abertos da Receita (arquivos sintéticos no formato oficial)."""
import datetime as dt
import zipfile

import pytest

from leadfinder import pipeline, receita_base
from leadfinder.cli import carregar_config

HOJE = dt.date(2026, 11, 26)
CFG = carregar_config("config.yaml")


def _linha(*campos):
    return ";".join(f'"{c}"' for c in campos)


def estab(basico, ordem, dv, fantasia, cnae, logradouro, numero, bairro, cep,
          municipio="6001", uf="RJ", situacao="02", inicio="20150310", matriz="1"):
    return _linha(basico, ordem, dv, matriz, fantasia, situacao, "20150310", "00", "", "",
                  inicio, cnae, "", "AVENIDA", logradouro, numero, "SALA 101", bairro, cep,
                  uf, municipio, "21", "999999999", "", "", "", "", "pessoal@gmail.com", "", "")


EMPRESAS = [
    _linha("11222333", "CLINICA SORRISO CARIOCA LTDA", "2062", "49", "250000,00", "03", ""),
    _linha("22333444", "ODONTO BARRA SERVICOS LTDA", "2062", "49", "80000,00", "01", ""),
    _linha("33444555", "ADVOCACIA SILVA E SOUZA", "2232", "49", "10000,00", "05", ""),
    _linha("44555666", "JOAO MEI CLINICA", "2135", "50", "5000,00", "01", ""),
    _linha("55666777", "SORRISO CARIOCA SP LTDA", "2062", "49", "90000,00", "01", ""),
    _linha("66777888", "CLINICA NOVA LTDA", "2062", "49", "90000,00", "01", ""),
    _linha("77000001", "LOPES PINTO CONSULTORIA E CORRETORA DE SEGUROS LTDA", "2062", "49", "10000,00", "01", ""),
    _linha("77000002", "LOPES PINTO ADVOGADOS ASSOCIADOS", "2232", "49", "50000,00", "05", ""),
    _linha("77000003", "ROSEMARY N. ROSA SOCIEDADE INDIVIDUAL DE ADVOCACIA", "2321", "49", "1000,00", "05", ""),
    _linha("77000004", "LOUREIRO E BRUM SOCIEDADE DE ADVOGADOS", "2232", "49", "1000,00", "05", ""),
    _linha("77000005", "FACIES CLINICA ODONTO-MEDICA LTDA", "2062", "49", "100000,00", "05", ""),
    _linha("77000006", "FACIES SERVICOS MEDICOS LTDA", "2062", "49", "10000,00", "01", ""),
]
ESTABS = [
    # Sorriso Carioca: matriz + filial, Barra da Tijuca
    estab("11222333", "0001", "81", "SORRISO CARIOCA", "8630504", "DAS AMERICAS", "500",
          "BARRA DA TIJUCA", "22640100"),
    estab("11222333", "0002", "62", "SORRISO CARIOCA RECREIO", "8630504", "DAS AMERICAS", "15000",
          "RECREIO DOS BANDEIRANTES", "22790700", matriz="2"),
    # Outra clínica no MESMO prédio (Av. das Américas, 500)
    estab("22333444", "0001", "05", "ODONTO BARRA", "8630504", "DAS AMERICAS", "500",
          "BARRA DA TIJUCA", "22640100"),
    # Escritório no Centro
    estab("33444555", "0001", "10", "", "6911701", "RIO BRANCO", "0085", "CENTRO", "20090003"),
    # MEI: deve sumir
    estab("44555666", "0001", "20", "CLINICA DO JOAO", "8630504", "DAS AMERICAS", "700",
          "BARRA DA TIJUCA", "22640102"),
    # Homônimo em SP: deve ser ignorado na importação
    estab("55666777", "0001", "30", "SORRISO CARIOCA", "8630504", "PAULISTA", "1000",
          "BELA VISTA", "01310100", municipio="7107", uf="SP"),
    # Baixada (situação 08): deve sumir
    estab("66777888", "0001", "40", "CLINICA NOVA", "8630504", "ATLANTICA", "10",
          "COPACABANA", "22010000", situacao="08"),
    # Aberta há menos de 2 anos
    estab("66777888", "0002", "21", "CLINICA NOVISSIMA", "8630504", "ATLANTICA", "20",
          "COPACABANA", "22010000", inicio="20260101", matriz="2"),
    # Mesmo prédio: corretora "LP" e o escritório Lopes Pinto
    estab("77000001", "0001", "01", "LP CORRETORA DE SEGUROS", "6622300", "MEXICO", "11",
          "CENTRO", "20031903"),
    estab("77000002", "0001", "02", "", "6911701", "MEXICO", "11", "CENTRO", "20031903"),
    # Sigla: RNR = Rosemary N. Rosa
    estab("77000003", "0001", "03", "", "6911701", "DO OUVIDOR", "21", "CENTRO", "20040040"),
    estab("77000004", "0001", "04", "", "6911701", "DO OUVIDOR", "21", "CENTRO", "20040040"),
    # Prédio com CEP próprio (22640-904) diferente do CEP da rua (22640-100)
    estab("77000005", "0001", "05", "FACIES ODONTOLOGIA", "8630504", "DAS AMERICAS", "500",
          "BARRA DA TIJUCA", "22640904"),
    estab("77000006", "0001", "06", "", "8630502", "PROFESSOR GASTAO BAHIANA", "155",
          "LAGOA", "22071030"),
]
SOCIOS = [
    _linha("11222333", "2", "MARIA DA SILVA", "***123456**", "22", "20150310", "", "***000000**", "", "00", "5"),
    _linha("11222333", "2", "JOAO DE SOUZA", "***654321**", "49", "20150310", "", "***000000**", "", "00", "6"),
]
SIMPLES = [
    _linha("11222333", "S", "20150310", "00000000", "N", "00000000", "00000000"),
    _linha("44555666", "S", "20200101", "00000000", "S", "20200101", "00000000"),
]
AUX = {
    "Municipios": [_linha("6001", "RIO DE JANEIRO"), _linha("5865", "NITEROI"), _linha("7107", "SAO PAULO")],
    "Qualificacoes": [_linha("49", "Sócio-Administrador"), _linha("22", "Sócio")],
    "Cnaes": [_linha("8630504", "Atividade odontológica"), _linha("6911701", "Serviços advocatícios")],
}


def _zip(pasta, nome, linhas):
    with zipfile.ZipFile(pasta / f"{nome}.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"K3241.{nome.upper()}CSV", ("\n".join(linhas) + "\n").encode("latin-1"))


@pytest.fixture(scope="module")
def base(tmp_path_factory):
    pasta = tmp_path_factory.mktemp("zips")
    _zip(pasta, "Estabelecimentos0", ESTABS[:4])
    _zip(pasta, "Estabelecimentos1", ESTABS[4:])
    _zip(pasta, "Empresas0", EMPRESAS)
    _zip(pasta, "Socios0", SOCIOS)
    _zip(pasta, "Simples", SIMPLES)
    for nome, linhas in AUX.items():
        _zip(pasta, nome, linhas)
    banco = pasta / "receita.sqlite"
    receita_base.importar(pasta, banco, CFG["filtros"]["municipios_aceitos"], "2026-11",
                          log=lambda *_: None)
    return receita_base.conectar(banco)


def test_importacao_filtra_e_descarta_dados_pessoais(base):
    cnpjs = {r[0] for r in base.execute("SELECT cnpj FROM estab")}
    assert "11222333000181" in cnpjs and "33444555000110" in cnpjs
    assert "44555666000120" not in cnpjs  # MEI
    assert "55666777000130" not in cnpjs  # SP
    assert "66777888000140" not in cnpjs  # baixada
    dump = "\n".join(base.iterdump())
    for proibido in ("gmail", "999999999", "***", "123456"):
        assert proibido not in dump
    assert receita_base.competencia(base) == "2026-11"


def test_interpretar_local(base):
    info = receita_base.interpretar_local(base, "11.222.333/0001-81", HOJE)
    assert info["razao_social"] == "CLINICA SORRISO CARIOCA LTDA"
    assert info["decisor"] == "Joao de Souza" and info["cargo"] == "Sócio-Administrador"
    assert info["porte"] == "EPP" and info["capital_social"] == 250000
    assert info["unidades_receita"] == 2
    assert info["cnae_descricao"] == "Atividade odontológica"
    assert receita_base.interpretar_local(base, "44555666000120", HOJE) is None


def test_casar_por_cep_numero_e_nome_no_mesmo_predio(base):
    end = "Av. das Américas, 500 - Barra da Tijuca, Rio de Janeiro - RJ, 22640-100, Brasil"
    r = receita_base.casar(base, "Sorriso Carioca Odontologia", end, ["8630504"])
    assert r["cnpj"] == "11222333000181" and r["confianca"] == "alta"
    r = receita_base.casar(base, "Odonto Barra", end, ["8630504"])
    assert r["cnpj"] == "22333444000105"


def test_casar_nao_chuta_quando_nome_e_generico(base):
    end = "Av. das Américas, 500 - Barra da Tijuca, Rio de Janeiro - RJ, 22640-100"
    r = receita_base.casar(base, "Clínica Odontológica", end, ["8630504"])
    assert r["cnpj"] is None and "2 CNPJ" in r["motivo"]


def test_casar_numero_com_zeros_a_esquerda(base):
    end = "Av. Rio Branco, 85 - Centro, Rio de Janeiro - RJ, 20090-003"
    r = receita_base.casar(base, "Silva e Souza Advogados", end, ["6911701"])
    assert r["cnpj"] == "33444555000110" and r["confianca"] == "alta"


def test_casar_so_pelo_nome_tem_confianca_media(base):
    r = receita_base.casar(base, "Silva Souza", "", ["6911701"])
    assert r["cnpj"] == "33444555000110" and r["confianca"] == "média"
    r = receita_base.casar(base, "Empresa Que Não Existe", "", [])
    assert r["cnpj"] is None


def test_descobrir_por_cnae_e_bairro(base):
    achados = receita_base.descobrir(base, CFG, HOJE)
    nomes = [a["empresa"] for a in achados]
    assert nomes[0] == "Sorriso Carioca"  # mais unidades primeiro
    assert "Odonto Barra" in nomes
    assert not any("Novissima" in n for n in nomes)  # menos de 2 anos
    assert not any("Joao" in n for n in nomes)  # MEI
    assert achados[0]["unidades_receita"] == 2
    assert achados[0]["endereco"].endswith("22640-100")


def test_pipeline_cruza_sem_chamar_brasilapi(base, tmp_path):
    from tests.test_leadfinder import FakeHttp

    entrada = tmp_path / "e.csv"
    entrada.write_text(
        "empresa,endereco,setor_busca\n"
        "Sorriso Carioca,\"Av. das Américas, 500 - Barra da Tijuca, Rio de Janeiro - RJ, 22640-100\","
        "clínica odontológica\n",
        encoding="utf-8")
    http = FakeHttp({})
    lead = pipeline.coletar(CFG, http, entrada=str(entrada), hoje=HOJE, log=lambda *_: None, base=base)[0]
    assert lead["cnpj"] == "11.222.333/0001-81"
    assert lead["decisor"] == "Joao de Souza"
    assert "confiança alta" in lead["cnpj_origem"]
    assert any("competência 2026-11" in f for f in lead["fontes"])
    assert "2 unidades (+20)" in lead["sinais"]
    assert not any("brasilapi" in u for u in http.pedidos)


def test_pipeline_fonte_receita(base):
    from tests.test_leadfinder import FakeHttp

    leads = pipeline.coletar(CFG, FakeHttp({}), fonte="receita", hoje=HOJE, log=lambda *_: None, base=base)
    assert leads[0]["empresa"] == "Sorriso Carioca"
    assert leads[0]["decisor"] == "Joao de Souza"
    # capital 10 + unidades 20 + região 10
    assert leads[0]["pontuacao"] == 40 and leads[0]["classe"] == "B"



# --- Casos do teste com a base real (nov/2026) ---

def test_casar_exige_atividade_do_setor(base):
    end = "Rua México, 11 - Centro, Rio de Janeiro - RJ, 20031-903"
    r = receita_base.casar(base, "LP Law", end, ["6911701"])
    assert r["cnpj"] == "77000002000102"  # escritório, não a corretora "LP"
    r = receita_base.casar(base, "Lopes Pinto Advogados Associados", end, ["6911701"])
    assert r["cnpj"] == "77000002000102" and r["confianca"] == "alta"
    r = receita_base.casar(base, "LP Seguros", end, ["6911701"])
    assert r["cnpj"] is None and "atividade" in r["motivo"]


def test_casar_por_sigla(base):
    end = "Travessa do Ouvidor, 21 - Centro, Rio de Janeiro - RJ, 20040-040"
    r = receita_base.casar(base, "RNR Advocacia", end, ["6911701"])
    assert r["cnpj"] == "77000003000103"


def test_casar_predio_com_cep_proprio(base):
    end = "Av. das Américas, 500 - Barra da Tijuca, Rio de Janeiro - RJ, 22640-100"
    r = receita_base.casar(base, "Facies Clínica Odonto-Médica", end, ["8630504"])
    assert r["cnpj"] == "77000005000105"
    # sem CEP, o número desempata entre os dois "Facies"
    r = receita_base.casar(base, "Facies", "Av. das Américas, 500 - Barra da Tijuca", ["8630504"])
    assert r["cnpj"] == "77000005000105"


def test_mesmo_cep_numero_diferente_vira_confianca_media(base):
    # Receita: Av. Rio Branco, 85 (20090-003). Diretório desatualizado: número 120.
    end = "Av. Rio Branco, 120 - Centro, Rio de Janeiro - RJ, 20090-003"
    r = receita_base.casar(base, "Silva e Souza Advogados", end, ["6911701"])
    assert r["cnpj"] == "33444555000110" and r["confianca"] == "média"
    assert "número diferente" in r["motivo"]


def test_descobrir_exclui_sa_aberta_orgao_publico_e_redes_grandes(base):
    import sqlite3
    con = sqlite3.connect(":memory:")
    base.backup(con)
    con.row_factory = sqlite3.Row
    con.execute("UPDATE empresa SET natureza = '2046' WHERE basico = '22333444'")  # S.A. aberta
    nomes = [a["empresa"] for a in receita_base.descobrir(con, CFG, HOJE)]
    assert "Odonto Barra" not in nomes and "Sorriso Carioca" in nomes
    cfg = {**CFG, "filtros": {**CFG["filtros"], "unidades_maximas": 1}}
    nomes = [a["empresa"] for a in receita_base.descobrir(con, cfg, HOJE)]
    assert "Sorriso Carioca" not in nomes  # 2 unidades > máximo


def test_descobrir_prefere_razao_quando_fantasia_e_nome_de_unidade(base):
    import sqlite3
    con = sqlite3.connect(":memory:")
    base.backup(con)
    con.row_factory = sqlite3.Row
    con.execute("UPDATE estab SET fantasia = 'UNIDADE BARRA II' WHERE basico = '22333444'")
    nomes = [a["empresa"] for a in receita_base.descobrir(con, CFG, HOJE)]
    assert "Odonto Barra Servicos Ltda" in nomes


def test_fonte_receita_nao_duplica(base):
    from tests.test_leadfinder import FakeHttp
    lead = pipeline.coletar(CFG, FakeHttp({}), fonte="receita", hoje=HOJE, log=lambda *_: None, base=base)[0]
    assert sum("Receita Federal" in f for f in lead["fontes"]) == 1
