/* Ipê Math — planilha de álgebra computacional.
 * Motor simbólico: nerdamer (MIT). Renderização: KaTeX. Gráficos: Plotly. */
'use strict';

// O interpretador com a sintaxe do Maple fica em kernel.js (MapleKernel).
const kernel = { reset: () => MapleKernel.reset() };
const evaluateCell = text => MapleKernel.evaluateCell(text);

/* ---------- Interface ---------- */

const sheet = document.getElementById('sheet');
const STORAGE_KEY = 'ipe-math-worksheet-v2';

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
    'diff(sin(x)^2*x, x);', 'diff(x^5, x$3);', 'int(x*exp(x), x);', 'int(x^2, x = 0 .. 3);',
    'int(exp(-x), x = 0 .. infinity);', 'limit(sin(x)/x, x = 0);', 'taylor(cos(x), x = 0, 8);',
    'series(exp(x), x = 1, 4);', 'sum(k^2, k = 1 .. 10);', 'product(k, k = 1 .. 5);',
  ]],
  ['Equações', [
    'solve(x^2 - 5*x + 6 = 0, x);', 'solve({x + y = 3, x - y = 1}, {x, y});', 'fsolve(cos(x) = x, x);',
    'eq := x^2 = 4;', 'lhs(eq);',
  ]],
  ['Álgebra', [
    'factor(x^3 - 1);', 'expand((x + 1)^4);', 'simplify(sin(x)^2 + cos(x)^2);', 'normal((x^2 - 1)/(x - 1));',
    'convert(1/(x^2 - 1), parfrac, x);', 'subs(x = 2, x^2 + 1);', 'eval(x^2 + y, {x = 1, y = 3});',
    'coeff(3*x^2 + 2*x + 1, x, 2);', 'numer((x+1)/(x-2));',
  ]],
  ['Numérico', [
    'evalf(Pi);', 'evalf[15](sqrt(2));', 'Digits := 15;', 'ifactor(360);', 'isprime(97);', 'binomial(10, 3);', '100!;',
  ]],
  ['Funções', [
    'f := x -> x^3 - 3*x;', 'f(2);', 'g := unapply(x^2 + 1, x);', 'seq(i^2, i = 1 .. 5);', '%;', 'restart;',
  ]],
  ['LinearAlgebra', [
    'with(LinearAlgebra):', 'A := Matrix([[1, 2], [3, 4]]);', 'Determinant(A);', 'MatrixInverse(A);',
    'Transpose(A);', 'A . A;', 'Eigenvalues(A);', 'CharacteristicPolynomial(A, lambda);', 'Rank(A);',
    'LinearSolve(A, Vector([5, 11]));', 'CrossProduct(Vector([1,0,0]), Vector([0,1,0]));',
  ]],
  ['inttrans', [
    'with(inttrans):', 'laplace(t^2, t, s);', 'invlaplace(1/(s^2 + 1), s, t);',
  ]],
  ['Gráficos', [
    'plot(sin(x), x = -Pi .. Pi);', 'plot([sin(x), cos(x)], x = 0 .. 2*Pi, color = [red, blue], title = "Trig");',
    'plot(x^3 - 3*x, x = -3 .. 3, y = -5 .. 5);', 'plot3d(sin(x)*cos(y), x = -3 .. 3, y = -3 .. 3);',
  ]],
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
  if (!data || !data.length || data.some(c => /derivar|integrar|resolver\(/.test(c.content))) data = [
    { type: 'text', content: 'Bem-vindo ao Ipê Math! A entrada segue a sintaxe do Maple: termine com ; para ver o resultado ou : para ocultá-lo. Enter executa.' },
    { type: 'math', content: 'f := x -> x^3 - 3*x;' },
    { type: 'math', content: 'diff(f(x), x);' },
    { type: 'math', content: 'solve(% = 0, x);' },
    { type: 'math', content: 'int(f(x), x = 0 .. 2);' },
    { type: 'math', content: 'plot([f(x), diff(f(x), x)], x = -2.5 .. 2.5);' },
  ];
  load(data);
})();

// Exporta para testes em Node
