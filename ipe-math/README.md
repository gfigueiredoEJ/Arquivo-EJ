# Ipê Math

Planilha de álgebra computacional que roda no navegador, com **a mesma sintaxe de entrada do Maple** (Maple Input 1-D): cálculo simbólico, equações, álgebra linear, transformadas e gráficos 2D/3D.

## Como usar

Abra `index.html` no navegador (precisa de internet na primeira carga para baixar as bibliotecas). Digite comandos e pressione **Enter**.

- `;` no fim mostra o resultado; `:` executa sem mostrar
- `%`, `%%`, `%%%`: último, penúltimo e antepenúltimo resultado
- `a := expr` atribui; `x := 'x'` ou `unassign('x')` desatribui; `restart;` limpa tudo
- `f := x -> x^2` ou `f := unapply(expr, x)` define funções
- `#` inicia comentário; **Shift+Enter** quebra linha; **Ctrl+Shift+Enter** executa tudo
- **Salvar/Abrir**: arquivo `.ipe` (a última planilha também fica salva no navegador)

## Comandos suportados

| Área | Comandos |
|---|---|
| Derivadas | `diff(f(x), x)`, `diff(f(x), x$2)`, `D(f)`, `D(f)(2)`, `D[1](h)`, `(D@@2)(f)`, `f'(x)`, `Diff(f(x), x)` (forma não avaliada), `implicitdiff(eq, y, x)` |
| Cálculo | `int(f, x)`, `int(f, x = a .. b)`, `limit(f, x = a)`, `sum(f, k = a .. b)`, `product`, `add`, `mul`, `seq`, `taylor(f, x = a, n)`, `series`, formas não avaliadas `Int`, `Sum`, `Limit`, `Product` e `value(%)` |
| Equações | `solve(eq, x)`, `solve({eq1, eq2}, {x, y})`, `fsolve(eq, x)`, `fsolve(eq, x = a .. b)`, `lhs`, `rhs` |
| Álgebra | `factor`, `expand`, `simplify`, `normal`, `convert(f, parfrac, x)`, `subs(x = a, f)`, `eval(f, x = a)`, `numer`, `denom`, `coeff`, `degree`, `collect` |
| Numérico | `evalf(e)`, `evalf(e, n)`, `evalf[n](e)`, `Digits := n`, `ifactor`, `isprime`, `ithprime`, `igcd`, `ilcm`, `irem`, `iquo`, `binomial`, `n!` |
| Constantes e funções | `Pi`, `I`, `infinity`, `exp`, `ln`, `log[b]`, `sqrt`, `abs`, `sin`…`arctan`, `sinh`… |
| `with(LinearAlgebra)` | `Matrix([[..],[..]])`, `<1, 2, 3>`, `<<1, 2> | <3, 4>>`, `Matrix(n, m, [...])`, `Matrix(n, n, shape = identity)`, `Vector([..])`, `A . B`, `A^(-1)`, `A[i, j]`, `Determinant`, `MatrixInverse`, `Transpose`, `Trace`, `Rank`, `Eigenvalues`, `CharacteristicPolynomial`, `LinearSolve`, `DotProduct`, `CrossProduct`, `RowDimension`, `ColumnDimension` (também `LinearAlgebra:-Determinant(A)`) |
| `with(inttrans)` | `laplace(f, t, s)`, `invlaplace(F, s, t)` |
| Gráficos | `plot(f, x = a .. b)`, `plot([f, g], x = a .. b, y = c .. d)`, paramétrico `plot([x(t), y(t), t = a .. b])`, `coords = polar`, opções `color`, `thickness`, `linestyle`, `legend`, `labels`, `title`, `view`, `scaling = constrained`, `discont`, `style = point`, `gridlines`; `plot3d(f, x = a .. b, y = c .. d)` (também paramétrico) |
| `with(plots)` | `display(p1, p2, ...)` (gráficos guardados em variáveis: `p1 := plot(...):`), `display(..., insequence = true)`, `animate(plot, [sin(k*x), x = 0 .. 2*Pi], k = 1 .. 3)`, `implicitplot`, `implicitplot3d`, `pointplot`, `pointplot3d`, `polarplot`, `contourplot`, `densityplot`, `fieldplot`, `gradplot`, `spacecurve`, `textplot`, `logplot`, `semilogplot`, `loglogplot`, `inequal` |
| Programação | `for i from 1 to n [by s] do ... end do`, `for x in L do`, `while ... do`, `if ... then ... elif ... else ... end if`, `F := proc(n) local r; ... return r end proc`, recursão, `break`, `next`, `printf`, `print`, `evalb`, `is`, `type`, `map`, `select`, `remove`, `assign`, `piecewise`, `seq`, `add`, `mul` |
| Listas e conjuntos | `[1, 2, 3]`, `{1, 2}`, `L[i]` (índice a partir de 1), `nops(L)` |

## Fluxo

1. Cada célula `>` é separada em instruções (`;` mostra, `:` oculta), respeitando blocos `do/if/proc`.
2. O interpretador (`kernel.js`) traduz a sintaxe do Maple para o motor simbólico e mantém variáveis, funções, `proc`, gráficos guardados, pacotes carregados por `with` e o histórico `%`.
3. O kernel roda num Web Worker, ou seja, em segundo plano. Um cálculo demorado não trava a página: **■ Interromper** encerra o cálculo e restaura a sessão refazendo as instruções anteriores.
4. Comandos de pacotes exigem `with(pacote)` ou a forma longa `pacote:-comando`, como no Maple.

## Limitações conhecidas

- O motor simbólico é o nerdamer, bem menos poderoso que o do Maple: algumas integrais, somas e simplificações ficam sem avaliar.
- `dsolve`/`odeplot` (equações diferenciais), `assume`, módulos e os pacotes `Student`/`Statistics` ainda não existem.
- `evalf` tem precisão máxima de ~16 dígitos.
- `e` é a constante de Euler (no Maple a constante é `exp(1)`, que também funciona).

## Arquitetura

- `kernel.js` — interpretador da linguagem Maple (expressões, `for`/`if`/`proc`, pacotes `plots`, `LinearAlgebra`, `inttrans`); roda num Web Worker
- `app.js` — interface de planilha (células, paleta, salvar/abrir, tema)
- `style.css` — tema claro/escuro
- Bibliotecas de código aberto: [nerdamer](https://github.com/jiggzson/nerdamer) (motor simbólico, MIT), [KaTeX](https://katex.org) (fórmulas, MIT), [Plotly.js](https://plotly.com/javascript/) (gráficos, MIT)
