# Lead finder da Ejota

Encontra PMEs do Rio de Janeiro com capacidade de investir R$ 10–20 mil, identifica o
decisor e pontua cada lead de 0 a 100. Usa só fontes públicas e respeita a LGPD.

## Como usar com o Claude Code
Peça "rode o lead finder" ou "quero leads de clínicas na Barra". A skill
`.claude/skills/lead-finder` conduz as 4 etapas: estudo de mercado, coleta, pontuação e
recomendação de tráfego pago.

## Como usar direto
```bash
cd lead-finder
pip install -r requirements.txt
```

1. Ajuste `config.yaml` (serviço, setores, regiões, limites).
2. Rode a busca. Com a chave da API do Google Places
   ([como obter](https://developers.google.com/maps/documentation/places/web-service/get-api-key)):
   ```bash
   GOOGLE_MAPS_API_KEY=sua_chave python -m leadfinder buscar --limite 30
   ```
   Ou a partir de uma lista própria (`empresa,site` e, opcional, `cnpj,bairro,telefone,nota,avaliacoes`):
   ```bash
   python -m leadfinder buscar --entrada empresas.csv
   ```
3. Abra `saida/leads_completo.csv`, use os links de consulta manual (Meta Ads, Google Ads,
   LinkedIn) e preencha `anuncios_meses`, `vagas_gestao`, `expansao_recente`, `linkedin`,
   `instagram`. Depois:
   ```bash
   python -m leadfinder repontuar
   ```
4. Resultado: `saida/leads.md` e `saida/leads.xlsx` (só classes A e B).

## Fontes
| Dado | Fonte |
|---|---|
| Nome, endereço, telefone, site, nota, avaliações | Google Places API (oficial) |
| CNPJ, porte, CNAE, capital social, abertura, sócios | Receita Federal, dados abertos via BrasilAPI |
| Pixel, tags, ferramentas, vagas, unidades, e-mail | Site oficial (respeitando robots.txt) |
| Anúncios ativos, LinkedIn, Instagram | Consulta manual (plataformas proíbem automação) |

## Limitações
- Número de funcionários não é público: conferir no LinkedIn.
- Se o site não mostra o CNPJ, o campo fica "não encontrado"; informe o CNPJ na lista de entrada.
- Sem os anúncios verificados manualmente, a pontuação máxima automática é 75.

## Testes
```bash
python -m pytest
```
