"""Linha de comando do lead finder da Ejota.

  python -m leadfinder buscar --config config.yaml
  python -m leadfinder buscar --config config.yaml --entrada empresas.csv
  python -m leadfinder repontuar --config config.yaml --arquivo saida/leads_completo.csv
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

    r = sub.add_parser("repontuar", help="recalcula após preencher as colunas manuais")
    r.add_argument("--config", default="config.yaml")
    r.add_argument("--arquivo", default="saida/leads_completo.csv")
    r.add_argument("--saida", default="saida")

    args = ap.parse_args(argv)
    cfg = carregar_config(args.config)

    if args.comando == "buscar":
        chave = os.environ.get("GOOGLE_MAPS_API_KEY")
        if not args.entrada and not chave:
            print("Defina GOOGLE_MAPS_API_KEY ou use --entrada empresas.csv", file=sys.stderr)
            return 2
        leads = coletar(cfg, Http(), chave=chave, entrada=args.entrada, limite=args.limite)
    else:
        leads = [calcular(l, cfg) for l in carregar_csv(args.arquivo)]
        leads.sort(key=lambda l: (bool(l.get("excluido")), -l["pontuacao"]))

    _resumo(leads, salvar(leads, args.saida))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
