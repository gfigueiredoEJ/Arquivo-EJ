"""Linha de comando do lead finder da Ejota.

  python -m leadfinder buscar --config config.yaml
  python -m leadfinder buscar --config config.yaml --entrada empresas.csv
  python -m leadfinder repontuar --config config.yaml --arquivo saida/leads_completo.csv
  python -m leadfinder base atualizar        # baixa e importa os dados abertos da Receita
  python -m leadfinder buscar --fonte receita # descobre empresas direto na base da Receita
"""
from __future__ import annotations

import argparse
import os
import sys

import yaml

from .http import Http
from .pipeline import calcular, coletar
from .report import carregar_csv, qualificados, salvar


def carregar_config(caminho: str) -> dict:
    with open(caminho, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _resumo(leads: list[dict], arquivos: dict) -> None:
    q = qualificados(leads)
    a = sum(1 for l in q if l["classe"] == "A")
    excl = sum(1 for l in leads if l.get("excluido"))
    print(f"\n{len(leads)} empresas analisadas, {excl} fora do perfil, "
          f"{len(q)} qualificadas ({a} A, {len(q) - a} B).")
    for nome, caminho in arquivos.items():
        print(f"  {nome}: {caminho}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="leadfinder")
    sub = ap.add_subparsers(dest="comando", required=True)

    b = sub.add_parser("buscar", help="coleta, enriquece e pontua leads")
    b.add_argument("--config", default="config.yaml")
    b.add_argument("--entrada", help="CSV com colunas empresa,site[,cnpj,bairro,telefone,nota,avaliacoes]")
    b.add_argument("--saida", default="saida")
    b.add_argument("--limite", type=int, help="máximo de empresas a enriquecer")
    b.add_argument("--fonte", choices=["maps", "receita"], default="maps",
                   help="maps: Google Places (precisa de chave); receita: base local da Receita")

    r = sub.add_parser("repontuar", help="recalcula após preencher as colunas manuais")
    r.add_argument("--config", default="config.yaml")
    r.add_argument("--arquivo", default="saida/leads_completo.csv")
    r.add_argument("--saida", default="saida")

    bs = sub.add_parser("base", help="dados abertos de CNPJ da Receita Federal")
    bs.add_argument("acao", choices=["atualizar", "importar", "info"])
    bs.add_argument("--config", default="config.yaml")
    bs.add_argument("--competencia", help="AAAA-MM (padrão: a mais recente)")
    bs.add_argument("--zips", default="dados/zips", help="pasta dos .zip baixados")
    bs.add_argument("--paralelos", type=int, default=4)
    bs.add_argument("--manter-zips", action="store_true", help="não apagar os .zip após importar")

    args = ap.parse_args(argv)
    cfg = carregar_config(args.config)

    if args.comando == "base":
        return _base(args, cfg)

    if args.comando == "buscar":
        chave = os.environ.get("GOOGLE_MAPS_API_KEY")
        if not args.entrada and not chave and args.fonte != "receita":
            print("Defina GOOGLE_MAPS_API_KEY, use --fonte receita ou --entrada empresas.csv",
                  file=sys.stderr)
            return 2
        try:
            leads = coletar(cfg, Http(), chave=chave, entrada=args.entrada, limite=args.limite,
                            fonte=args.fonte)
        except ValueError as erro:
            print(erro, file=sys.stderr)
            return 2
    else:
        leads = [calcular(l, cfg) for l in carregar_csv(args.arquivo)]
        leads.sort(key=lambda l: (bool(l.get("excluido")), -l["pontuacao"]))

    _resumo(leads, salvar(leads, args.saida))
    return 0


def _base(args, cfg: dict) -> int:
    import shutil
    from pathlib import Path

    from . import receita_base, receita_download

    banco = cfg.get("base_receita", "dados/receita.sqlite")
    if args.acao == "info":
        if not Path(banco).exists():
            print(f"Base não encontrada em {banco}. Rode: python -m leadfinder base atualizar")
            return 1
        con = receita_base.conectar(banco)
        for chave, valor in con.execute("SELECT chave, valor FROM meta"):
            print(f"{chave}: {valor}")
        return 0
    competencia = args.competencia
    if args.acao == "atualizar":
        pasta = receita_download.baixar(args.zips, competencia, args.paralelos)
        competencia = pasta.name
    else:
        pasta = Path(args.zips)
        if competencia:
            pasta = pasta / competencia
        competencia = competencia or pasta.name
    receita_base.importar(pasta, banco, cfg["filtros"]["municipios_aceitos"], competencia)
    if args.acao == "atualizar" and not args.manter_zips:
        shutil.rmtree(pasta)
        print(f"Arquivos .zip apagados ({pasta}); a base fica em {banco}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
