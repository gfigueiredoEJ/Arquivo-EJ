/* Ipê Math — folha de trabalho no estilo do Maple.
 * Interpretador: kernel.js (MapleKernel). Fórmulas: KaTeX. Gráficos: Plotly. */
'use strict';

const sheet = document.getElementById('sheet');
const statusEl = document.getElementById('status');
const STORAGE_KEY = 'ipe-math-worksheet-v3';

const HELP = `Comandos (sintaxe do Maple). Termine com ; para ver o resultado ou : para ocultar.
  Definições:  f := x -> x^2 + 1;    a := 3;    g := unapply(x^2, x);    x := 'x';    restart;
  Derivadas:   diff(f(x), x);   diff(f(x), x$2);   D(f);   D(f)(2);   f'(x);   implicitdiff(x^2 + y^2 = 1, y, x);
  Cálculo:     int(f(x), x = 0 .. 1);   limit(sin(x)/x, x = 0);   limit(1/x, x = 0, right);   taylor(exp(x), x = 0, 6);   sum(k^2, k = 1 .. n);
  Equações:    solve(x^2 - 4 = 0, x);   S := solve({x + y = 3, x - y = 1}, {x, y});   assign(S);   fsolve(cos(x) = x, x);
  Álgebra:     factor  expand  simplify  normal  subs(x = 2, expr)  eval(expr, x = 2)  evalb(a = b)  map(x -> x^2, L)
  Numérico:    evalf(Pi);   evalf[15](sqrt(2));   Digits := 15;   ifactor(360);   isprime(97);
  Matrizes:    with(LinearAlgebra):   A := Matrix([[1, 2], [3, 4]]);   v := <1, 2>;   Determinant(A);   Eigenvalues(A);   A . v;
  Gráficos:    plot(sin(x), x = -Pi .. Pi);   plot([cos(t), sin(t), t = 0 .. 2*Pi]);   plot3d(x^2 - y^2, x = -2 .. 2, y = -2 .. 2);
  with(plots): p1 := plot(f(x), x = 0 .. 2):  p2 := plot(x, x = 0 .. 2, color = blue):  display(p1, p2);
               implicitplot(x^2 + y^2 = 4, x = -3 .. 3, y = -3 .. 3);   pointplot([[1, 2], [2, 3]]);   polarplot(1 + cos(t));
               animate(plot, [sin(k*x), x = 0 .. 2*Pi], k = 1 .. 3);   contourplot  densityplot  fieldplot  spacecurve  textplot  logplot  inequal
  Programação: for i from 1 to 5 do i^2 end do;   while k < 10 do k := k + 1 end do;   if x > 0 then 1 else -1 end if;
               F := proc(n) local r; r := n^2; return r end proc;   printf("%d\\n", 42);   seq(i^2, i = 1 .. 5);   add(k, k = 1 .. 100);
  Histórico:   %  (último resultado)   %%   %%%
Atalhos: Enter executa · Shift+Enter nova linha · Ctrl+J novo prompt abaixo · Ctrl+K acima · Ctrl+T texto · Ctrl+Delete apaga o grupo · ■ Interromper para cálculos longos`;

/* ---------- Saída ---------- */

function renderTex(el, tex) {
  try { katex.render(tex, el, { displayMode: true, throwOnError: false }); }
  catch (e) { el.textContent = tex; }
}

function renderOutput(outEl, blocks) {
  outEl.innerHTML = '';
  for (const b of blocks) {
    const div = document.createElement('div');
    if (b.tex !== undefined) { div.className = 'eq'; renderTex(div, b.tex); }
    else if (b.note !== undefined) { div.className = 'note'; div.textContent = b.note; }
    else if (b.error !== undefined) { div.className = 'err'; div.textContent = b.error; }
    else if (b.plot) {
      div.className = 'plot';
      outEl.appendChild(div);
      const P = b.plot;
      const layout = Object.assign({
        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', font: { color: '#000000', family: 'Times New Roman, serif' },
      }, P.layout);
      layout.margin = Object.assign({ l: 50, r: 20, t: P.layout.title ? 40 : 16, b: 40 }, P.layout.margin || {});
      if (P.is3d) { div.classList.add('plot3d'); layout.margin = Object.assign({ l: 0, r: 0, t: P.layout.title ? 40 : 0, b: 0 }, P.layout.margin || {}); }
      else {
        layout.xaxis = Object.assign({ gridcolor: '#eeeeee', zerolinecolor: '#000000' }, layout.xaxis);
        layout.yaxis = Object.assign({ gridcolor: '#eeeeee', zerolinecolor: '#000000' }, layout.yaxis);
      }
      if (P.animated) div.classList.add('animated');
      Plotly.newPlot(div, { data: P.data, layout, frames: P.frames || [], config: { responsive: true, displaylogo: false } });
      continue;
    }
    outEl.appendChild(div);
  }
  outEl.hidden = !blocks.length;
}

/* ---------- Grupos de execução ---------- */

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
let cellSeq = 0;

function createCell(type = 'math', content = '', ref = null, where = 'after') {
  const cell = document.createElement('div');
  cell.className = 'group ' + type;
  cell.dataset.type = type;
  const id = 'in-' + (++cellSeq);
  cell.innerHTML = `
    <div class="line">
      ${type === 'math' ? '<span class="prompt" aria-hidden="true">&gt;</span>' : ''}
      <textarea id="${id}" class="input" rows="1" spellcheck="false" aria-label="${type === 'math' ? 'Entrada' : 'Texto'}"></textarea>
    </div>
    <div class="output" hidden></div>`;
  const ta = cell.querySelector('textarea');
  ta.value = content;
  if (ref) (where === 'before' ? ref.before(cell) : ref.after(cell)); else sheet.appendChild(cell);
  requestAnimationFrame(() => autosize(ta));

  ta.addEventListener('input', () => { autosize(ta); save(); });
  ta.addEventListener('focus', () => {
    document.querySelectorAll('.group.focused').forEach(c => c.classList.remove('focused'));
    cell.classList.add('focused');
  });
  ta.addEventListener('keydown', ev => onKey(ev, cell, ta));
  return cell;
}

const focusCell = (c, atEnd = true) => {
  if (!c) return;
  const ta = c.querySelector('textarea'); ta.focus();
  const p = atEnd ? ta.value.length : 0; ta.setSelectionRange(p, p);
};

function onKey(ev, cell, ta) {
  const k = ev.key;
  if (k === 'Enter' && ev.ctrlKey && ev.shiftKey) { ev.preventDefault(); runAll(); return; }
  if ((k === 'j' || k === 'J') && ev.ctrlKey) { ev.preventDefault(); focusCell(createCell('math', '', cell, 'after')); return; }
  if ((k === 'k' || k === 'K') && ev.ctrlKey) { ev.preventDefault(); focusCell(createCell('math', '', cell, 'before')); return; }
  if ((k === 't' || k === 'T') && ev.ctrlKey) { ev.preventDefault(); focusCell(createCell('text', '', cell, 'after')); return; }
  if (k === 'Delete' && ev.ctrlKey) { ev.preventDefault(); deleteCell(cell); return; }
  if (k === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    if (cell.dataset.type === 'math') runCell(cell);
    let next = cell.nextElementSibling;
    if (!next || next.dataset.type !== 'math') next = createCell('math', '', cell, 'after');
    focusCell(next);
    save();
    return;
  }
  if (k === 'Backspace' && ta.value === '' && sheet.children.length > 1) {
    ev.preventDefault();
    const prev = cell.previousElementSibling || cell.nextElementSibling;
    cell.remove(); save(); focusCell(prev);
    return;
  }
  // setas passam de um grupo para outro, como no Maple
  if (k === 'ArrowUp' && !ta.value.slice(0, ta.selectionStart).includes('\n') && cell.previousElementSibling) {
    ev.preventDefault(); focusCell(cell.previousElementSibling);
  }
  if (k === 'ArrowDown' && !ta.value.slice(ta.selectionEnd).includes('\n') && cell.nextElementSibling) {
    ev.preventDefault(); focusCell(cell.nextElementSibling, false);
  }
}

function deleteCell(cell) {
  const other = cell.previousElementSibling || cell.nextElementSibling;
  cell.remove();
  if (!sheet.children.length) focusCell(createCell());
  else focusCell(other);
  save();
}

/* ---------- Motor de cálculo em segundo plano (Web Worker) ----------
 * Um cálculo travado não congela a página: o botão Interromper encerra o worker,
 * cria outro e refaz em silêncio as instruções já executadas para restaurar a sessão. */
const NERDAMER_URL = 'https://cdn.jsdelivr.net/npm/nerdamer@1.1.13/all.min.js';
const Engine = (() => {
  let worker = null, mode = 'worker', seq = 0, log = [], busy = 0;
  const pending = new Map();
  const local = (op, text) => Promise.resolve(op === 'reset' ? (MapleKernel.reset(), []) : MapleKernel.evaluateCell(text));
  function spawn() {
    const src = `importScripts(${JSON.stringify(NERDAMER_URL)});\n${MapleKernelFactory.toString()}\nMapleKernelFactory(self);\n` +
      `self.onmessage = e => { const { id, op, text } = e.data; let blocks = [];` +
      ` try { if (op === 'reset') MapleKernel.reset(); else if (op !== 'ping') blocks = MapleKernel.evaluateCell(text); }` +
      ` catch (err) { blocks = [{ error: 'Error, ' + (err && err.message || err) }]; } self.postMessage({ id, blocks }); };`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = e => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p.resolve(e.data.blocks); } };
    worker.onerror = ev => { ev.preventDefault(); fallback(); };
  }
  function fallback() { // sem worker (navegador antigo ou bloqueado): calcula na própria página
    if (mode === 'local') return;
    mode = 'local';
    try { worker && worker.terminate(); } catch (e) {}
    worker = null;
    for (const [, p] of pending) p.resolve(null);
    pending.clear();
    MapleKernel.reset();
    for (const t of log) MapleKernel.evaluateCell(t);
  }
  function post(op, text) {
    if (mode === 'local') return local(op, text);
    return new Promise(resolve => { const id = ++seq; pending.set(id, { resolve }); worker.postMessage({ id, op, text }); });
  }
  async function call(op, text) {
    busy++; showBusy(true);
    try {
      let r = await post(op, text);
      if (r === null) r = await local(op, text);
      if (op === 'reset') log = [];
      else if (op === 'eval') log.push(text);
      return r;
    } finally { busy--; if (!busy) showBusy(false); }
  }
  async function interrupt() {
    if (mode === 'local' || !busy) return;
    worker.terminate();
    for (const [, p] of pending) p.resolve([{ error: 'Warning, computation interrupted' }]);
    pending.clear();
    spawn();
    setStatus('Restaurando a sessão…');
    for (const t of log) await post('eval', t);
    setStatus('Interrompido');
  }
  try {
    spawn();
    const t = setTimeout(fallback, 15000);
    post('ping').then(r => { if (r) clearTimeout(t); });
  } catch (e) { mode = 'local'; }
  return { eval: text => call('eval', text), reset: () => call('reset'), interrupt, get mode() { return mode; } };
})();

const btnStop = document.getElementById('btn-stop');
btnStop.onclick = () => Engine.interrupt();
function showBusy(on) { btnStop.hidden = !on; document.body.classList.toggle('busy', on); }

async function runCell(cell) {
  const src = cell.querySelector('textarea').value;
  const out = cell.querySelector('.output');
  if (/^\s*\?/.test(src)) { renderOutput(out, [{ note: HELP }]); return; }
  if (!src.trim()) { renderOutput(out, []); return; }
  cell.classList.add('running');
  setStatus('Calculando…');
  const t0 = performance.now();
  const blocks = await Engine.eval(src);
  cell.classList.remove('running');
  if (!cell.isConnected) return;
  renderOutput(out, blocks);
  setStatus(`Pronto · ${((performance.now() - t0) / 1000).toFixed(2)} s`);
}

async function runAll() {
  await Engine.reset();
  for (const c of sheet.querySelectorAll('.group.math')) await runCell(c);
}

function setStatus(s) { statusEl.textContent = s; }

/* ---------- Arquivo ---------- */

function save() {
  const data = [...sheet.children].map(c => ({ type: c.dataset.type, content: c.querySelector('textarea').value }));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  return data;
}

function load(data, run = true) {
  sheet.innerHTML = '';
  if (!run) Engine.reset();
  data.forEach(c => createCell(c.type, c.content));
  if (!data.length) createCell();
  if (run) runAll();
  focusCell(sheet.lastElementChild);
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}
const EMBEDDED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

/* ---------- Barra de ferramentas ---------- */

const current = () => document.querySelector('.group.focused') || sheet.lastElementChild;
document.getElementById('btn-run-all').onclick = runAll;
document.getElementById('btn-prompt').onclick = () => focusCell(createCell('math', '', current(), 'after'));
document.getElementById('btn-text').onclick = () => focusCell(createCell('text', '', current(), 'after'));
document.getElementById('btn-help').onclick = () => {
  const c = createCell('math', '?', current(), 'after'); runCell(c); focusCell(createCell('math', '', c, 'after'));
};

const btnNew = document.getElementById('btn-new');
btnNew.onclick = () => {
  if (btnNew.dataset.armed || [...sheet.querySelectorAll('textarea')].every(t => !t.value.trim())) {
    delete btnNew.dataset.armed; btnNew.textContent = 'Novo';
    load([], false); setStatus('Pronto');
    return;
  }
  btnNew.dataset.armed = '1'; btnNew.textContent = 'Apagar tudo?';
  setTimeout(() => { delete btnNew.dataset.armed; btnNew.textContent = 'Novo'; }, 3000);
};

document.getElementById('btn-save').onclick = async () => {
  const json = JSON.stringify({ app: 'ipe-math', version: 1, cells: save() }, null, 2);
  if (EMBEDDED) {
    try { await navigator.clipboard.writeText(json); toast('Folha copiada. Cole num arquivo .ipe para guardar.'); }
    catch (e) { toast('Não foi possível copiar. A folha continua salva neste navegador.'); }
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'folha.ipe'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
document.getElementById('file-open').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try { const j = JSON.parse(await f.text()); load(j.cells || j); toast('Folha aberta.'); }
  catch (e) { toast('Arquivo inválido: ' + e.message); }
  ev.target.value = '';
};

/* ---------- Início: folha em branco (ou a última folha que você usou) ---------- */

(function init() {
  let data = [];
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch (e) {}
  if (!data.some(c => c.content && c.content.trim())) data = [];
  load(data);
  setStatus('Pronto');
})();
