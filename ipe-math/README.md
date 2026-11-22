# Ipê Math

Planilha de álgebra computacional que roda no navegador: cálculo simbólico, resolução de equações, matrizes e gráficos 2D/3D, com comandos em português.

## Como usar

Abra `index.html` no navegador (precisa de internet na primeira carga para baixar as bibliotecas). Digite uma expressão numa célula e pressione **Enter**.

- **Shift+Enter**: nova linha na mesma célula
- **Ctrl+Shift+Enter**: executar todas as células
- `%`: último resultado
- `a := expr`: define variável; `f(x) := expr`: define função
- Várias instruções numa célula: separe com `;` ou quebra de linha
- **Salvar/Abrir**: exporta/importa a planilha como arquivo `.ipe` (o navegador também guarda automaticamente a última planilha)

## Comandos

| Comando | Exemplo |
|---|---|
| Derivada | `derivar(sin(x)^2, x)`, `derivar(x^5, x, 3)` |
| Integral | `integrar(x*e^x, x)`, `integrar(x^2, x, 0, 3)` |
| Limite | `limite(sin(x)/x, x, 0)` |
| Série de Taylor | `taylor(cos(x), x, 0, 6)` |
| Somatório / produtório | `somatorio(k^2, k, 1, 10)`, `produtorio(k, k, 1, 5)` |
| Equações | `resolver(x^2-5x+6=0, x)` |
| Sistemas | `resolver([x+y=3, x-y=1], [x, y])` |
| Álgebra | `fatorar`, `expandir`, `simplificar`, `parcial` (frações parciais), `mdc`, `mmc` |
| Numérico | `avaliar(pi, 20)` |
| Matrizes | `A := matriz([1,2],[3,4])`, `det(A)`, `inversa(A)`, `transposta(A)`, `A*A` |
| Transformadas | `laplace(t^2, t, s)`, `ilaplace(1/(s^2+1), s, t)` |
| Gráficos | `plot([sin(x), cos(x)], x, -2pi, 2pi)`, `plot3d(sin(x)*cos(y), x, y, -3, 3, -3, 3)` |
| Sessão | `variaveis()`, `limpar()`, `ajuda()` |

Nomes em inglês (`diff`, `integrate`, `solve`, `factor`…) e funções como `sen`, `tg`, `ln` também funcionam.

## Arquitetura

- `app.js` — kernel (parsing, aliases, comandos especiais) e interface de planilha
- `style.css` — tema claro/escuro
- Bibliotecas de código aberto: [nerdamer](https://github.com/jiggzson/nerdamer) (motor simbólico, MIT), [KaTeX](https://katex.org) (renderização, MIT), [Plotly.js](https://plotly.com/javascript/) (gráficos, MIT)
