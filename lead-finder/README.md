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

1. Ajuste `config.yaml` (serviço, setores, CNAEs, regiões, limites).
2. Monte a base local da Receita (uma vez por mês; baixa ~8 GB, guarda ~1 GB):
   ```bash
   python -m leadfinder base atualizar
   ```
   Descubra empresas direto nela, sem chave nenhuma:
   ```bash
   python -m leadfinder buscar --fonte receita --limite 50
   ```
3. Ou rode a busca pelo Google Maps. Com a chave da API do Google Places
   ([como obter](https://developers.google.com/maps/documentation/places/web-service/get-api-key)):
   ```bash
   GOOGLE_MAPS_API_KEY=sua_chave python -m leadfinder buscar --limite 30
   ```
   Ou a partir de uma lista própria (`empresa,site` e, opcional, `cnpj,bairro,telefone,nota,avaliacoes`):
   ```bash
   python -m leadfinder buscar --entrada empresas.csv
   ```
4. Abra `saida/leads_completo.csv`, use os links de consulta manual (Meta Ads, Google Ads,
   LinkedIn) e preencha `anuncios_meses`, `vagas_gestao`, `expansao_recente`, `linkedin`,
   `instagram`. Depois:
   ```bash
   python -m leadfinder repontuar
   ```
5. Resultado: `saida/leads.md` e `saida/leads.xlsx` (só classes A e B).

## Fontes
| Dado | Fonte |
|---|---|
| Nome, endereço, telefone, site, nota, avaliações | Google Places API (oficial) |
| CNPJ, porte, CNAE, capital social, abertura, sócios, filiais | Receita Federal, dados abertos (base local; BrasilAPI como reserva) |
| Pixel, tags, ferramentas, vagas, unidades, e-mail | Site oficial (respeitando robots.txt) |
| Anúncios ativos, LinkedIn, Instagram | Consulta manual (plataformas proíbem automação) |

## Limitações
- Número de funcionários não é público: conferir no LinkedIn.
- A maioria dos sites de PME não publica o CNPJ (0 de 5 no teste real). A base local da
  Receita resolve pelo CEP + número + nome; quando o endereço tem vários CNPJs e o nome não
  desempata, o campo fica "não encontrado" em vez de chutar.
- Porte "DEMAIS" na Receita não exclui a empresa (só indica que ela não declarou ME/EPP);
  a exclusão vem do teto de capital social e do município fora da Região Metropolitana.
- Sem os anúncios verificados manualmente, a pontuação máxima automática é 75.
- A base local da Receita não vai para o git (~500 MB): em cada máquina nova, rode
  `base atualizar` (~40 min, dependendo da conexão com o servidor da Receita).
- Os dados abertos não ligam empresas do mesmo grupo econômico: subsidiárias de grupos
  grandes podem aparecer na descoberta. Revise os nomes antes de abordar.

## Como funciona o cruzamento com a Receita
`base atualizar` baixa os dados abertos oficiais (compartilhamento da Receita em
arquivos.receitafederal.gov.br), guarda só estabelecimentos **ativos** da Região
Metropolitana, remove MEIs e descarta e-mail, telefone, CPF e faixa etária dos sócios.
Para cada empresa do Google Maps, `casar()` procura pelo CEP e número do endereço e
desempata pelo nome (palavras genéricas como "clínica" ou "advogados" não contam).

## Testes
```bash
python -m pytest
```
