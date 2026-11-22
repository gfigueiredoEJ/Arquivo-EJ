/* Ipê Math — planilha de álgebra computacional.
 * Motor simbólico: nerdamer (MIT). Renderização: KaTeX. Gráficos: Plotly. */
'use strict';

/* ---------- Utilidades de parsing ---------- */

// Divide uma string por vírgulas de nível superior (ignora vírgulas dentro de (), [], {}).
function splitArgs(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

// Se `src` é uma chamada `nome(args)` no nível superior, retorna {name, args}.
function parseCall(src) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(src.trim());
  if (!m) return null;
  // garante que o parêntese final fecha o primeiro
  let depth = 0;
  const body = src.trim().slice(m[1].length).trim();
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') { depth--; if (depth === 0 && i !== body.length - 1) return null; }
  }
  return { name: m[1], args: splitArgs(m[2]) };
}

// Remove colchetes externos de uma lista "[a, b]" -> ["a","b"]
function listItems(s) {
  s = s.trim();
  if (s.startsWith('[') && s.endsWith(']')) return splitArgs(s.slice(1, -1));
  return [s];
}

/* ---------- Aliases em português -> nerdamer ---------- */

const ALIASES = {
  derivar: 'diff', derivada: 'diff',
  integral: 'integrate', primitiva: 'integrate',
  resolver: 'solve', raizes: 'roots',
  fatorar: 'factor', expandir: 'expand', simplificar: 'simplify',
  limite: 'limit', somatorio: 'sum', soma: 'sum', produtorio: 'product',
  matriz: 'matrix', vetor: 'vector', det: 'determinant', determinante: 'determinant',
  inversa: 'invert', transposta: 'transpose', identidade: 'imatrix',
  mdc: 'gcd', mmc: 'lcm', fatorial: 'factorial', raiz: 'sqrt', ln: 'log',
  sen: 'sin', tg: 'tan', arcsen: 'asin', arccos: 'acos', arctg: 'atan',
  coeficientes: 'coeffs', grau: 'deg', parcial: 'partfrac', fracoesparciais: 'partfrac',
  laplace: 'laplace', ilaplace: 'ilt', media: 'mean', mediana: 'median', moda: 'mode',
  produtoescalar: 'dot', produtovetorial: 'cross',
};

function applyAliases(expr) {
  return expr.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] + '(' : m);
}

/* ---------- Estado do kernel ---------- */

const kernel = {
  last: null,          // último resultado (string)
  vars: new Set(),
  funcs: new Set(),
  reset() {
    this.vars.forEach(v => { try { nerdamer.setVar(v, 'delete'); } catch (e) {} });
    this.funcs.forEach(f => { try { nerdamer.clearFunctions && nerdamer.clearFunctions(); } catch (e) {} });
    this.vars.clear(); this.funcs.clear(); this.last = null;
    try { nerdamer.clear('all'); } catch (e) {}
  },
};

/* ---------- Resultados ---------- */
// Cada avaliação produz uma lista de "blocos": {tex}, {approx}, {plot}, {note}, {error}

function texOf(sym) {
  try { return sym.toTeX().replace(/\{vmatrix\}/g, '{bmatrix}').replace(/\\mathrm\{(sin|cos|tan|log|exp|asin|acos|atan|sinh|cosh|tanh)\}/g, '\\$1'); }
  catch (e) { return String(sym); }
}

function numericApprox(sym) {
  try {
    const s = sym.toString();
    if (/[a-zA-Z]/.test(s.replace(/\b(pi|e|sqrt|log|sin|cos|tan|atan|asin|acos|abs|factorial)\b/g, ''))) return null;
    const v = nerdamer(s).evaluate().text('decimals');
    if (v === s) return null;
    const num = Number(v);
    if (!isFinite(num)) return v === s ? null : v;
    return String(+num.toPrecision(12));
  } catch (e) { return null; }
}

function exactBlock(sym, label) {
  const blocks = [{ tex: (label ? label + ' = ' : '') + texOf(sym) }];
  const a = numericApprox(sym);
  if (a !== null) blocks.push({ approx: a });
  return blocks;
}

/* ---------- Comandos especiais ---------- */

const SPECIAL = {
  // integrar(f, x)  ou  integrar(f, x, a, b)
  integrar(args) {
    if (args.length === 4) {
      const [f, x, a, b] = args;
      const r = nerdamer(`defint(${f},${a},${b},${x})`);
      return withResult([{ tex: `\\int_{${texOf(nerdamer(a))}}^{${texOf(nerdamer(b))}} \\left(${texOf(nerdamer(f))}\\right)\\,d${x} = ${texOf(r)}` }], r);
    }
    const [f, x = 'x'] = args;
    const r = nerdamer(`integrate(${f},${x})`);
    return withResult([{ tex: `\\int \\left(${texOf(nerdamer(f))}\\right)\\,d${x} = ${texOf(r)} + C` }], r);
  },

  // derivar(f, x [, n])
  derivar(args) {
    const [f, x = 'x', n = '1'] = args;
    const r = nerdamer(`diff(${f},${x},${n})`);
    const ord = n === '1' ? '' : `^{${n}}`;
    return withResult([{ tex: `\\frac{d${ord}}{d${x}${ord}}\\left(${texOf(nerdamer(f))}\\right) = ${texOf(r)}` }], r);
  },

  // resolver(eq, x)   |   resolver([eq1, eq2], [x, y])
  resolver(args) {
    const [eqs, vars] = args;
    const eqList = listItems(eqs);
    if (eqList.length > 1) {
      const sol = nerdamer.solveEquations(eqList, vars ? listItems(vars) : undefined);
      const parts = sol.map(([v, val]) => `${v} = ${texOf(nerdamer(String(val)))}`);
      const str = '[' + sol.map(([v, val]) => `${v}=${val}`).join(',') + ']';
      return [[{ tex: parts.join(',\\quad ') }], str];
    }
    const x = vars || guessVar(eqList[0]);
    const r = nerdamer(`solve(${eqList[0]},${x})`);
    const items = splitArgs(r.toString().replace(/^\[|\]$/g, ''));
    if (!items.length) return [[{ note: 'Nenhuma solução encontrada.' }], '[]'];
    const tex = items.map(v => `${x} = ${texOf(nerdamer(v))}`).join(',\\quad ');
    const approx = items.map(v => numericApprox(nerdamer(v))).filter(Boolean);
    const blocks = [{ tex }];
    if (approx.length === items.length && approx.some((a, i) => a !== items[i])) blocks.push({ approx: approx.join(',  ') });
    return [blocks, r.toString()];
  },

  // avaliar(expr [, digitos])  — aproximação numérica
  avaliar(args) {
    const [e, digits = '15'] = args;
    const v = nerdamer(e).evaluate().text('decimals');
    const n = Number(v);
    const shown = isFinite(n) ? String(+n.toPrecision(Math.min(+digits, 17))) : v;
    return [[{ tex: `${texOf(nerdamer(e))} \\approx ${shown}` }], shown];
  },

  // taylor(f, x, a, n)
  taylor(args) {
    const [f, x = 'x', a = '0', n = '5'] = args;
    const N = parseInt(n, 10);
    let deriv = f; const terms = [];
    for (let k = 0; k <= N; k++) {
      const val = nerdamer(deriv, { [x]: a }).toString();
      let fact = 1; for (let j = 2; j <= k; j++) fact *= j;
      if (val !== '0') terms.push(`(${val})/${fact}*(${x}-(${a}))^${k}`);
      deriv = nerdamer(`diff(${deriv},${x})`).toString();
    }
    const r = nerdamer(terms.length ? terms.join('+') : '0').expand();
    return withResult([{ tex: `${texOf(nerdamer(f))} \\approx ${texOf(r)} + O\\left(${a === '0' ? x : `(${x}-${a})`}^{${N + 1}}\\right)` }], r);
  },

  // limite(f, x, a)
  limite(args) {
    const [f, x = 'x', a = '0'] = args;
    const r = nerdamer(`limit(${f},${x},${a})`);
    const at = a === 'Infinity' || a === 'inf' ? '\\infty' : texOf(nerdamer(a));
    return withResult([{ tex: `\\lim_{${x} \\to ${at}} ${texOf(nerdamer(f))} = ${texOf(r)}` }], r);
  },

  // plot(f, x, a, b)  ou  plot([f, g], x, a, b)
  plot(args) {
    const [fs, x = 'x', a = '-10', b = '10'] = args;
    const lo = Number(nerdamer(a).evaluate().text('decimals'));
    const hi = Number(nerdamer(b).evaluate().text('decimals'));
    const traces = listItems(fs).map(f => {
      const fn = nerdamer(f).buildFunction([x]);
      const xs = [], ys = [];
      const N = 600;
      for (let i = 0; i <= N; i++) {
        const t = lo + (hi - lo) * i / N;
        let y; try { y = fn(t); } catch (e) { y = NaN; }
        xs.push(t); ys.push(isFinite(y) && Math.abs(y) < 1e8 ? y : null);
      }
      return { x: xs, y: ys, type: 'scatter', mode: 'lines', name: f, line: { width: 2.2 } };
    });
    return [[{ plot: { data: traces, layout: { xaxis: { title: x }, showlegend: traces.length > 1 } } }], null];
  },

  // plot3d(f, x, y, xa, xb, ya, yb)
  plot3d(args) {
    const [f, x = 'x', y = 'y', xa = '-5', xb = '5', ya = '-5', yb = '5'] = args;
    const num = s => Number(nerdamer(s).evaluate().text('decimals'));
    const [x0, x1, y0, y1] = [num(xa), num(xb), num(ya), num(yb)];
    const fn = nerdamer(f).buildFunction([x, y]);
    const N = 60, xs = [], ys = [], zs = [];
    for (let i = 0; i <= N; i++) xs.push(x0 + (x1 - x0) * i / N);
    for (let j = 0; j <= N; j++) ys.push(y0 + (y1 - y0) * j / N);
    for (const yy of ys) zs.push(xs.map(xx => { const z = fn(xx, yy); return isFinite(z) ? z : null; }));
    return [[{ plot: { data: [{ x: xs, y: ys, z: zs, type: 'surface', colorscale: 'Viridis', showscale: false }], layout: { scene: { xaxis: { title: x }, yaxis: { title: y } } } } }], null];
  },

  ajuda() {
    return [[{ note: 'Digite uma expressão e pressione Enter. Exemplos: derivar(sin(x)^2, x) · integrar(x*e^x, x, 0, 1) · resolver(x^2-5x+6=0, x) · f(x) := x^3-2x · plot([sin(x), cos(x)], x, -2pi, 2pi). Use % para o último resultado. Veja a paleta à esquerda para mais comandos.' }], null];
  },
  variaveis() {
    const list = [...kernel.vars].map(v => `${v} = ${nerdamer(v).toString()}`);
    const fl = [...kernel.funcs];
    return [[{ note: (list.length ? 'Variáveis: ' + list.join('; ') : 'Nenhuma variável definida.') + (fl.length ? '  ·  Funções: ' + fl.join(', ') : '') }], null];
  },
  limpar() { kernel.reset(); return [[{ note: 'Variáveis e funções apagadas.' }], null]; },
};
// aliases para comandos especiais
Object.assign(SPECIAL, {
  integrate: SPECIAL.integrar, integral: SPECIAL.integrar, diff: SPECIAL.derivar, derivada: SPECIAL.derivar,
  solve: SPECIAL.resolver, evalf: SPECIAL.avaliar, N: SPECIAL.avaliar, limit: SPECIAL.limite,
  grafico: SPECIAL.plot, grafico3d: SPECIAL.plot3d, help: SPECIAL.ajuda,
});

function withResult(blocks, sym) {
  const a = numericApprox(sym);
  if (a !== null && a !== sym.toString()) blocks.push({ approx: a });
  return [blocks, sym.toString()];
}

function guessVar(expr) {
  try {
    const vs = nerdamer(expr.replace(/=/g, '-(') + (expr.includes('=') ? ')' : '')).variables();
    return vs.includes('x') ? 'x' : (vs[0] || 'x');
  } catch (e) { return 'x'; }
}

/* ---------- Avaliação de uma linha ---------- */

function evaluateStatement(src) {
  src = src.trim();
  if (!src || src.startsWith('#')) return [];
  // % = último resultado
  if (src.includes('%')) {
    if (kernel.last == null) throw new Error('Não há resultado anterior para %.');
    src = src.replace(/%/g, '(' + kernel.last + ')');
  }

  // Definição de função: f(x, y) := expr
  let m = /^([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:=\s*([\s\S]+)$/.exec(src);
  if (m) {
    const [, name, params, body] = m;
    const ps = splitArgs(params);
    const b = nerdamer(applyAliases(body)).toString();
    nerdamer.setFunction(name, ps, b);
    kernel.funcs.add(name);
    return [{ tex: `${name}\\left(${ps.join(', ')}\\right) := ${texOf(nerdamer(b))}` }];
  }
  // Atribuição: a := expr
  m = /^([A-Za-z_]\w*)\s*:=\s*([\s\S]+)$/.exec(src);
  if (m) {
    const [, name, body] = m;
    const [blocks, str] = evalExpr(body);
    if (str == null) throw new Error('Não é possível atribuir esse resultado a uma variável.');
    nerdamer.setVar(name, str);
    kernel.vars.add(name);
    kernel.last = str;
    return blocks.map((b, i) => (i === 0 && b.tex ? { tex: `${name} := ${texOf(nerdamer(str))}` } : b));
  }
  const [blocks, str] = evalExpr(src);
  if (str != null) kernel.last = str;
  return blocks;
}

function evalExpr(src) {
  const call = parseCall(src);
  if (call && SPECIAL[call.name]) {
    const args = call.args.map(applyAliases);
    return SPECIAL[call.name](args);
  }
  const expr = applyAliases(src);
  const sym = nerdamer(expr);
  if (expr.includes('=') && !/[<>!]=|==/.test(expr)) return [[{ tex: texOf(sym) }], sym.toString()];
  return [exactBlock(sym), sym.toString()];
}

// Uma célula pode ter várias linhas/instruções separadas por quebra de linha ou ';'
function evaluateCell(text) {
  const statements = [];
  for (const line of text.split('\n')) {
    splitTopLevel(line, ';').forEach(s => s.trim() && statements.push(s));
  }
  const blocks = [];
  for (const st of statements) {
    try { blocks.push(...evaluateStatement(st)); }
    catch (e) { blocks.push({ error: traduzErro(e, st) }); break; }
  }
  return blocks;
}

function splitTopLevel(s, sep) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

function traduzErro(e, st) {
  const msg = (e && e.message) || String(e);
  return `Erro em "${st.trim()}": ${msg}`;
}

/* ---------- Interface ---------- */

const sheet = document.getElementById('sheet');
const STORAGE_KEY = 'ipe-math-worksheet-v1';

function renderTex(el, tex) {
  try { katex.render(tex, el, { displayMode: true, throwOnError: false }); }
  catch (e) { el.textContent = tex; }
}

function renderOutput(outEl, blocks) {
  outEl.innerHTML = '';
  for (const b of blocks) {
    const div = document.createElement('div');
    if (b.tex !== undefined) { div.className = 'eq'; renderTex(div, b.tex); }
    else if (b.approx !== undefined) { div.className = 'approx'; div.textContent = '≈ ' + b.approx; }
    else if (b.note !== undefined) { div.className = 'note'; div.textContent = b.note; }
    else if (b.error !== undefined) { div.className = 'err'; div.textContent = b.error; }
    else if (b.plot) {
      div.className = 'plot';
      outEl.appendChild(div);
      const dark = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().startsWith('#1');
      const ink = dark ? '#ecebef' : '#1d1b19', grid = dark ? '#2f2d36' : '#e3ded8';
      const layout = Object.assign({
        margin: { l: 50, r: 20, t: 20, b: 40 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: ink }, xaxis: {}, yaxis: {},
      }, b.plot.layout);
      layout.xaxis = Object.assign({ gridcolor: grid, zerolinecolor: ink }, layout.xaxis);
      layout.yaxis = Object.assign({ gridcolor: grid, zerolinecolor: ink }, layout.yaxis);
      Plotly.newPlot(div, b.plot.data, layout, { responsive: true, displaylogo: false });
      continue;
    }
    outEl.appendChild(div);
  }
}

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

function createCell(type = 'math', content = '', afterEl = null) {
  const cell = document.createElement('div');
  cell.className = 'cell ' + type;
  cell.dataset.type = type;
  cell.innerHTML = `
    <div class="row">
      <span class="prompt">${type === 'math' ? '&gt;' : '¶'}</span>
      <textarea class="input" rows="1" spellcheck="false" placeholder="${type === 'math' ? 'Digite uma expressão… (Enter executa, Shift+Enter nova linha)' : 'Texto livre / anotações'}"></textarea>
      <div class="tools">
        <button data-act="up" title="Mover para cima">↑</button>
        <button data-act="down" title="Mover para baixo">↓</button>
        <button data-act="del" title="Excluir célula">✕</button>
      </div>
    </div>
    <div class="output"></div>`;
  const ta = cell.querySelector('textarea');
  ta.value = content;
  if (afterEl) afterEl.after(cell); else sheet.appendChild(cell);
  requestAnimationFrame(() => autosize(ta));

  ta.addEventListener('input', () => { autosize(ta); save(); });
  ta.addEventListener('focus', () => { document.querySelectorAll('.cell.focused').forEach(c => c.classList.remove('focused')); cell.classList.add('focused'); });
  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.ctrlKey && ev.shiftKey) { ev.preventDefault(); runAll(); return; }
    if (ev.key === 'Enter' && !ev.shiftKey && type === 'math') {
      ev.preventDefault();
      runCell(cell);
      const next = cell.nextElementSibling;
      if (next) next.querySelector('textarea').focus();
      else createCell('math', '', cell).querySelector('textarea').focus();
    }
    if (ev.key === 'Backspace' && ta.value === '' && sheet.children.length > 1) {
      ev.preventDefault();
      const prev = cell.previousElementSibling || cell.nextElementSibling;
      cell.remove(); save();
      if (prev) prev.querySelector('textarea').focus();
    }
  });
  cell.querySelector('.tools').addEventListener('click', ev => {
    const act = ev.target.dataset.act;
    if (act === 'del') { cell.remove(); if (!sheet.children.length) createCell(); }
    if (act === 'up' && cell.previousElementSibling) cell.previousElementSibling.before(cell);
    if (act === 'down' && cell.nextElementSibling) cell.nextElementSibling.after(cell);
    save();
  });
  return cell;
}

function runCell(cell) {
  const ta = cell.querySelector('textarea');
  const out = cell.querySelector('.output');
  if (cell.dataset.type !== 'math') return;
  renderOutput(out, evaluateCell(ta.value));
}

function runAll() {
  kernel.reset();
  sheet.querySelectorAll('.cell.math').forEach(runCell);
}

function save() {
  const data = [...sheet.children].map(c => ({ type: c.dataset.type, content: c.querySelector('textarea').value }));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  return data;
}

function load(data) {
  sheet.innerHTML = '';
  kernel.reset();
  data.forEach(c => createCell(c.type, c.content));
  if (!data.length) createCell();
  runAll();
}

/* ---------- Paleta ---------- */

const PALETTE = [
  ['Cálculo', [
    'derivar(sin(x)^2*x, x)', 'derivar(x^5, x, 3)', 'integrar(x*e^x, x)', 'integrar(x^2, x, 0, 3)',
    'limite(sin(x)/x, x, 0)', 'taylor(cos(x), x, 0, 6)', 'somatorio(k^2, k, 1, 10)',
  ]],
  ['Álgebra', [
    'resolver(x^2-5x+6=0, x)', 'resolver([x+y=3, x-y=1], [x, y])', 'fatorar(x^3-1)',
    'expandir((x+1)^4)', 'simplificar(sin(x)^2+cos(x)^2)', 'parcial(1/(x^2-1), x)', 'avaliar(sqrt(2), 12)',
  ]],
  ['Matrizes', [
    'A := matriz([1,2],[3,4])', 'det(A)', 'inversa(A)', 'transposta(A)', 'A*A',
  ]],
  ['Gráficos', [
    'plot([sin(x), cos(x)], x, -2pi, 2pi)', 'plot(x^3-3x, x, -3, 3)', 'plot3d(sin(x)*cos(y), x, y, -3, 3, -3, 3)',
  ]],
  ['Definições', [
    'f(x) := x^3 - 2x', 'derivar(f(x), x)', 'a := 5', 'variaveis()', 'limpar()',
  ]],
  ['Transformadas', [
    'laplace(t^2, t, s)', 'ilaplace(1/(s^2+1), s, t)',
  ]],
  ['Ajuda', ['ajuda()']],
];

function buildPalette() {
  const pal = document.getElementById('palette');
  for (const [title, items] of PALETTE) {
    const h = document.createElement('h3'); h.textContent = title; pal.appendChild(h);
    for (const it of items) {
      const b = document.createElement('button'); b.textContent = it;
      b.title = 'Inserir na célula atual';
      b.addEventListener('click', () => {
        let cell = document.querySelector('.cell.focused.math');
        if (!cell || cell.querySelector('textarea').value.trim()) {
          cell = createCell('math', '', cell || sheet.lastElementChild);
        }
        const ta = cell.querySelector('textarea');
        ta.value = it; autosize(ta); ta.focus(); runCell(cell); save();
      });
      pal.appendChild(b);
    }
  }
}

/* ---------- Barra superior ---------- */

document.getElementById('btn-run-all').onclick = runAll;
document.getElementById('btn-add-math').onclick = () => createCell('math', '', document.querySelector('.cell.focused')).querySelector('textarea').focus();
document.getElementById('btn-add-text').onclick = () => createCell('text', '', document.querySelector('.cell.focused')).querySelector('textarea').focus();
document.getElementById('btn-clear').onclick = () => { if (confirm('Começar uma nova planilha? O conteúdo atual será apagado.')) load([{ type: 'math', content: '' }]); };
document.getElementById('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'ipe-math', version: 1, cells: save() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'planilha.ipe'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
document.getElementById('file-open').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try { const j = JSON.parse(await f.text()); load(j.cells || j); }
  catch (e) { alert('Arquivo inválido: ' + e.message); }
  ev.target.value = '';
};
document.getElementById('btn-theme').onclick = () => {
  const root = document.documentElement;
  const isDark = getComputedStyle(root).getPropertyValue('--bg').trim().startsWith('#1');
  root.dataset.theme = isDark ? 'light' : 'dark';
  try { localStorage.setItem('ipe-theme', root.dataset.theme); } catch (e) {}
  runAll();
};

/* ---------- Inicialização ---------- */

(function init() {
  try { const t = localStorage.getItem('ipe-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  buildPalette();
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
  if (!data || !data.length) data = [
    { type: 'text', content: 'Bem-vindo ao Ipê Math! Digite expressões e pressione Enter. Use a paleta à esquerda para exemplos.' },
    { type: 'math', content: 'f(x) := x^3 - 3x' },
    { type: 'math', content: 'derivar(f(x), x)' },
    { type: 'math', content: 'resolver(%=0, x)' },
    { type: 'math', content: 'integrar(f(x), x, 0, 2)' },
    { type: 'math', content: 'plot([f(x), derivar(f(x), x)], x, -2.5, 2.5)' },
  ];
  load(data);
})();

// Exporta para testes em Node
if (typeof module !== 'undefined') module.exports = { evaluateCell, kernel };
