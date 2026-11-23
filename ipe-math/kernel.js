/* Ipê Math — interpretador com a sintaxe de entrada 1-D do Maple.
 * Traduz comandos no estilo Maple para o motor simbólico nerdamer.
 * Exporta: MapleKernel.evaluateCell(texto) -> blocos de saída; MapleKernel.reset(). */
'use strict';

// Fábrica nomeada: a interface recria o kernel dentro de um Web Worker a partir deste código.
function MapleKernelFactory(global) {
  const nd = global.nerdamer || (typeof require !== 'undefined' ? require('nerdamer/all.min') : null);

  /* ======================= Estado ======================= */
  const state = { history: [], eqs: new Map(), vars: new Set(), funcs: new Map(), plots: new Map(), procs: new Map(), procOut: [], depth: 0, digits: 10, packages: new Set() };

  function reset() {
    state.vars.forEach(v => { try { nd.setVar(v, 'delete'); } catch (e) {} });
    try { nd.clear('all'); } catch (e) {}
    try { nd.clearVars && nd.clearVars(); } catch (e) {}
    state.vars.clear(); state.eqs.clear(); state.funcs.clear(); state.plots.clear(); state.procs.clear(); state.procOut = []; state.depth = 0; state.history = []; state.digits = 10; state.packages.clear();
  }

  class MapleError extends Error {}
  const err = (where, msg) => new MapleError(where ? `Error, (in ${where}) ${msg}` : `Error, ${msg}`);

  /* ======================= Utilidades de texto ======================= */

  // Divide por separador no nível superior, respeitando (), [], {} e strings.
  function splitTop(s, sep = ',') {
    const out = []; let depth = 0, cur = '', q = false, ang = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') q = !q;
      if (!q) {
        // < … > é construtor de vetor/matriz quando aparece onde se espera um operando
        if (ch === '<' && s[i + 1] !== '=' && s[i + 1] !== '>' && /(^|[(,=\[{|<.*+\-/^:])\s*$/.test(cur.length ? cur : (out.length ? ',' : ''))) { ang++; depth++; }
        else if (ch === '>' && ang > 0 && s[i - 1] !== '-' && s[i + 1] !== '=') { ang--; depth--; }
        else if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      }
      cur += ch;
    }
    if (cur.trim() !== '' || out.length) out.push(cur.trim());
    return out.filter((x, i, a) => !(x === '' && i === a.length - 1 && a.length === 1));
  }

  function matchClose(s, i) { // s[i] é ( [ {
    const open = s[i], close = { '(': ')', '[': ']', '{': '}' }[open];
    let depth = 0, q = false;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '"') q = !q;
      if (q) continue;
      if (s[j] === '(' || s[j] === '[' || s[j] === '{') depth++;
      else if (s[j] === ')' || s[j] === ']' || s[j] === '}') { depth--; if (depth === 0) return s[j] === close ? j : -1; }
    }
    return -1;
  }

  const isWrapped = (s, o, c) => { s = s.trim(); return s[0] === o && matchClose(s, 0) === s.length - 1 && s.endsWith(c); };
  const unwrap = s => s.trim().slice(1, -1);
  const listOrSet = s => (isWrapped(s, '{', '}') || isWrapped(s, '[', ']')) ? splitTop(unwrap(s)).filter(x => x !== '') : [s.trim()];
  const isString = s => /^"[\s\S]*"$/.test(s.trim());
  const strVal = s => s.trim().slice(1, -1);

  // "x = a..b" -> {v, a, b}
  function parseRange(s, where) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*\.\.\s*([\s\S]+)$/.exec(s);
    if (!m) throw err(where, `invalid range: ${s}`);
    return { v: m[1], a: tr(m[2]), b: tr(m[3]) };
  }
  // "x = a" -> {v, a}
  function parseEq(s) {
    const parts = splitTop(s, '=');
    if (parts.length !== 2) return null;
    return { lhs: parts[0], rhs: parts[1] };
  }
  // equação -> expressão "lhs - (rhs)"
  function eqToExpr(s) {
    const e = parseEq(s);
    return e ? `(${tr(e.lhs)})-(${tr(e.rhs)})` : tr(s);
  }

  /* ======================= Números e formatação ======================= */

  const N = s => { const v = Number(nd(s).evaluate().text('decimals')); return v; };

  function fmtFloat(x, digits) {
    if (!isFinite(x)) return x > 0 ? 'Float(infinity)' : x < 0 ? '-Float(infinity)' : 'Float(undefined)';
    if (x === 0) return '0.';
    const d = Math.min(digits, 16);
    let s = x.toPrecision(d);
    if (/e/.test(s)) { const [m, e] = s.split('e'); return `${m.includes('.') ? m : m + '.'} 10^(${+e})`; }
    if (!s.includes('.')) s += '.';
    return s;
  }

  function shortFloat(x) {
    let s = String(+x.toPrecision(Math.min(state.digits, 16)));
    if (/e/.test(s)) { const [m, e] = s.split('e'); return `${m.includes('.') ? m : m + '.'} 10^(${+e})`; }
    return s.includes('.') ? s : s + '.';
  }
  // aplica formato de ponto flutuante a todos os números de uma string (exceto expoentes inteiros)
  function floatify(str, digits) {
    return str.replace(/(\^\(?-?)?(\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g, (m, pre, num) =>
      pre ? m : fmtFloat(Number(num), digits));
  }

  function evalfStr(expr, digits) {
    let txt = nd(expr).evaluate().text('decimals');
    const cm = /^(-?[\d.]+(?:e[+-]?\d+)?)([+-][\d.]+(?:e[+-]?\d+)?)\*i$/.exec(txt);
    if (cm && Math.abs(Number(cm[2])) < 1e-7 * (1 + Math.abs(Number(cm[1])))) txt = cm[1];
    if (/^-?[\d.]+(e[+-]?\d+)?$/.test(txt)) return fmtFloat(Number(txt), digits);
    return floatify(txt, digits);
  }

  /* ======================= TeX ======================= */

  function mapleTeX(tex) {
    return tex
      .replace(/\{vmatrix\}/g, '{bmatrix}')
      .replace(/\\mathrm\{log\}/g, '\\ln')
      .replace(/\\mathrm\{log10\}/g, '\\log_{10}')
      .replace(/\\mathrm\{a(sin|cos|tan)\}/g, '\\arc$1')
      .replace(/\\mathrm\{(sin|cos|tan|sec|csc|cot|sinh|cosh|tanh|exp|max|min)\}/g, '\\$1')
      .replace(/\\mathrm\{(\w+)\}/g, '\\operatorname{$1}')
      .replace(/(?<![A-Za-z\\])i(?![A-Za-z])/g, '\\mathrm{I}')
      .replace(/iI/g, 'i')
      .replace(/\\cdot/g, '\\,');
  }

  function bigFact(v) {
    return String(v).replace(/factorial\((\d+)\)/g, (m, k) => { let r = 1n; for (let j = 2n; j <= BigInt(k); j++) r *= j; return r.toString(); });
  }
  function tex(str) {
    if (/^-?\d+$/.test(String(str).trim())) return String(str).trim();
    try { return mapleTeX(nd(str).toTeX()); } catch (e) { return str.replace(/\*/g, '\\,'); }
  }
  function floatTeX(str) { // mantém os decimais como estão
    return str.replace(/\*\*/g, '^').replace(/\*/g, '\\,').replace(/\bpi\b/g, '\\pi').replace(/\bi\b/g, '\\mathrm{I}')
      .replace(/\^\(([^()]*)\)/g, '^{$1}').replace(/\^(-?\d+)/g, '^{$1}');
  }
  const eqTeX = (l, r) => `${tex(l)} = ${tex(r)}`;

  /* ======================= Tradução Maple -> nerdamer ======================= */

  const RENAME = {
    ln: 'log', arcsin: 'asin', arccos: 'acos', arctan: 'atan', arcsec: 'asec', arccsc: 'acsc', arccot: 'acot',
    arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh',
    normal: 'simplify', igcd: 'gcd', ilcm: 'lcm', irem: 'mod', signum: 'sign', ceil: 'ceil',
    Re: 'realpart', Im: 'imagpart', conjugate: 'conjugate', argument: 'arg',
    Determinant: 'determinant', MatrixInverse: 'invert', Transpose: 'transpose',
    IdentityMatrix: 'imatrix', degree: 'deg', erf: 'erf', GAMMA: 'factorial_gamma',
  };
  const CONST = { Pi: 'pi', I: 'i', infinity: 'Infinity', true: 'true', false: 'false' };

  // Traduz uma expressão Maple para uma string que o nerdamer entende,
  // avaliando os comandos Maple aninhados (diff, int, solve, …).
  // f'(x) -> D(f)(x);  (D@@2)(f) -> D(D(f))
  function preD(src) {
    return String(src)
      .replace(/\(\s*D\s*@@\s*(\d+)\s*\)\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (m, n, f) => 'D('.repeat(+n) + f + ')'.repeat(+n))
      .replace(/(^|[^\w'])([A-Za-z_]\w*)('+)\s*\(/g, (m, pre, f, q) => pre + 'D('.repeat(q.length) + f + ')'.repeat(q.length) + '(');
  }

  function tr(src) {
    src = pkgPrefix(preD(String(src).trim()).replace(/(\d+)!/g, 'factorial($1)'));
    let out = '', i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"') { const j = src.indexOf('"', i + 1); out += src.slice(i, j + 1); i = j + 1; continue; }
      const idm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (idm && !/[A-Za-z_]/.test(src[i - 1] || '')) {
        let name = idm[0], j = i + name.length, sub = null;
        // índice: evalf[n](...), log[b](...)
        if (src[j] === '[') {
          const k = matchClose(src, j);
          if (k > 0 && src[k + 1] === '(') { sub = src.slice(j + 1, k); j = k + 1; }
        }
        if (src[j] === '(') {
          const k = matchClose(src, j);
          if (k < 0) throw err(null, '`)` unexpected / missing');
          const args = splitTop(src.slice(j + 1, k));
          const r = callResult(name, args, sub);
          // D(f)(2): o resultado é uma função, aplica direto
          if (r.fname && src[k + 1] === '(') out += r.fname;
          else out += '(' + r.value + ')';
          i = k + 1;
          continue;
        }
        if (sub !== null) { i = i + name.length; out += CONST[name] || name; continue; }
        out += Object.prototype.hasOwnProperty.call(CONST, name) ? CONST[name] : state.eqs.has(name) ? state.eqs.get(name) : state.vars.has(name) ? `(${nd(vn(name)).toString()})` : name;
        i = j;
        continue;
      }
      // indexação Maple 1-based:  L[2], A[1,2], f(x)[1]
      if (ch === '[' && /[A-Za-z0-9_)\]]$/.test(out)) {
        const k = matchClose(src, i);
        const idx = splitTop(src.slice(i + 1, k)).map(tr);
        const [base, rest] = popOperand(out);
        out = rest + (idx.length === 1 ? `vecget(${base},(${idx[0]})-1)` : `matget(${base},(${idx[0]})-1,(${idx[1]})-1)`);
        i = k + 1;
        continue;
      }
      // produto matricial A.B (não confundir com decimais nem com ..)
      if (ch === '.' && src[i + 1] !== '.' && src[i - 1] !== '.' && !/\d/.test(src[i + 1] || '') && !/\d$/.test(out)) {
        out += '*'; i++; continue;
      }
      // indexação Maple 1-based:  L[2], A[1,2], f(x)[1]
      if (ch === '[' && /[A-Za-z0-9_)\]]$/.test(out)) {
        const k = matchClose(src, i);
        const idx = splitTop(src.slice(i + 1, k)).map(tr);
        const [base, rest] = popOperand(out);
        out = rest + (idx.length === 1 ? `vecget(${base},(${idx[0]})-1)` : `matget(${base},(${idx[0]})-1,(${idx[1]})-1)`);
        i = k + 1;
        continue;
      }
      // produto matricial A.B (não confundir com decimais nem com ..)
      if (ch === '.' && src[i + 1] !== '.' && src[i - 1] !== '.' && !/\d/.test(src[i + 1] || '') && !/\d$/.test(out)) {
        out += '*'; i++; continue;
      }
      if (ch === '{' || ch === '[') { // conjunto ou lista literal; sequências (solve, seq) entram achatadas
        const k = matchClose(src, i);
        out += '[' + splitTop(src.slice(i + 1, k)).filter(x => x !== '').flatMap(seqItems).join(',') + ']';
        i = k + 1; continue;
      }
      // construtores <1, 2, 3> (vetor coluna), <1 | 2 | 3> (linha) e <<1, 2> | <3, 4>> (matriz por colunas)
      if (ch === '<' && /(^|[(,=\[{+\-*/^|:])\s*$/.test(out)) {
        const k = matchAngle(src, i);
        if (k > 0) { out += '(' + angleValue(src.slice(i + 1, k)) + ')'; i = k + 1; continue; }
      }
      // (f + g)(x), (f@g)(x): aritmética e composição de funções
      if (ch === '(') {
        const k = matchClose(src, i);
        const inner = k > 0 ? src.slice(i + 1, k) : '';
        if (k > 0 && src[k + 1] === '(' && /^[\sA-Za-z_0-9+\-*/^@.]+$/.test(inner) && (inner.match(/[A-Za-z_]\w*/g) || []).some(n => state.funcs.has(n) || state.procs.has(n))) {
          const k2 = matchClose(src, k + 1), a = src.slice(k + 2, k2);
          let ex;
          if (inner.includes('@')) ex = inner.split('@').map(t => t.trim()).reverse().reduce((acc, fn) => `${fn}(${acc})`, a);
          else ex = inner.replace(/[A-Za-z_]\w*/g, n => (state.funcs.has(n) || state.procs.has(n) ? `${n}(${a})` : n));
          out += '(' + tr(ex) + ')'; i = k2 + 1; continue;
        }
      }
      out += ch; i++;
    }
    // A^(-1) com A matriz -> inversa
    out = out.replace(/(\b[A-Za-z_]\w*)\s*\^\s*\(\s*-1\s*\)/g, (m, name) => isMatrix(name) ? `invert(${name})` : m);
    return out;
  }

  // itens de um elemento de lista: uma chamada que devolve sequência (solve, seq) vira vários itens
  function seqItems(x) {
    const t = x.trim();
    const cm = /^([A-Za-z_]\w*)\s*\(/.exec(t);
    if (cm && CMD[cm[1]] && matchClose(t, t.indexOf('(')) === t.length - 1) {
      const r = CMD[cmdName(cm[1])](splitTop(t.slice(t.indexOf('(') + 1, -1)));
      if (r && r.isSeq) return r.items;
      if (r && r.value !== undefined) return [r.value];
    }
    return [tr(t)];
  }
  function matchAngle(s, i) {
    let d = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '<') d++;
      else if (s[j] === '>' && s[j - 1] !== '-') { d--; if (d === 0) return j; }
    }
    return -1;
  }
  function angleValue(body) {
    const cols = splitTop(body, '|');
    if (cols.length > 1 || /^\s*</.test(body)) {
      const colVals = cols.map(c => { c = c.trim(); return c.startsWith('<') ? splitTop(c.slice(1, matchAngle(c, 0))) : [c]; });
      if (colVals.every(c => c.length === 1)) return `matrix([${colVals.map(c => tr(c[0])).join(',')}])`; // vetor linha
      const rows = colVals[0].map((_, r) => '[' + colVals.map(c => tr(c[r])).join(',') + ']');
      return `matrix(${rows.join(',')})`;
    }
    const items = splitTop(body);
    if (items.length === 1 && /;/.test(items[0])) return `matrix(${items[0].split(';').map(r => '[' + splitTop(r).map(tr).join(',') + ']').join(',')})`;
    return `matrix(${items.map(x => `[${tr(x)}]`).join(',')})`;
  }

  function popOperand(out) {
    let j = out.length - 1;
    if (out[j] === ')' || out[j] === ']') {
      let depth = 0;
      for (; j >= 0; j--) {
        if (out[j] === ')' || out[j] === ']') depth++;
        else if (out[j] === '(' || out[j] === '[') { depth--; if (depth === 0) break; }
      }
      while (j > 0 && /\w/.test(out[j - 1])) j--;
    } else {
      while (j > 0 && /\w/.test(out[j - 1])) j--;
    }
    return [out.slice(j), out.slice(0, j)];
  }

  function isMatrix(str) {
    try { return /^matrix\(/.test(nd(str).toString()); } catch (e) { return false; }
  }

  // Valor de uma chamada aninhada (string nerdamer)
  // comandos que só existem depois de with(pacote) ou com pacote:-comando
  const PKG_OF = {};
  const addPkg = (c, p) => { PKG_OF[c] = (PKG_OF[c] || []).concat(p); };
  ['CharacteristicPolynomial', 'ColumnDimension', 'CrossProduct', 'Determinant', 'DotProduct', 'Eigenvalues', 'IdentityMatrix', 'LinearSolve',
    'MatrixInverse', 'Rank', 'RowDimension', 'Trace', 'Transpose'].forEach(c => addPkg(c, 'LinearAlgebra'));
  ['laplace', 'invlaplace'].forEach(c => addPkg(c, 'inttrans'));
  ['Gradient', 'Hessian', 'Jacobian', 'Laplacian', 'Divergence', 'Curl', 'DirectionalDiff', 'VectorField', 'SetCoordinates'].forEach(c => addPkg(c, 'VectorCalculus'));
  ['Gradient', 'Hessian', 'Jacobian', 'DirectionalDerivative', 'TangentPlane', 'SecondDerivativeTest', 'LagrangeMultipliers', 'MultiInt', 'TaylorApproximation', 'CriticalPoints'].forEach(c => addPkg(c, 'Student_MultivariateCalculus'));
  ['grad', 'hessian', 'jacobian', 'laplacian', 'diverge', 'curl', 'det', 'inverse', 'transpose'].forEach(c => addPkg(c, 'linalg'));
  ['animate', 'contourplot', 'densityplot', 'display', 'fieldplot', 'gradplot', 'implicitplot', 'implicitplot3d', 'inequal', 'logplot', 'loglogplot',
    'odeplot', 'pointplot', 'pointplot3d', 'polarplot', 'semilogplot', 'spacecurve', 'textplot', 'intersectplot'].forEach(c => addPkg(c, 'plots'));
  const PKGS = 'LinearAlgebra|inttrans|plots|VectorCalculus|linalg|Student|student';
  const pkgPrefix = src => String(src)
    .replace(/\bStudent\s*\[\s*MultivariateCalculus\s*\]\s*\[\s*([A-Za-z_]\w*)\s*\]/g, 'PKGOK__$1')
    .replace(/\bStudent\s*:-\s*MultivariateCalculus\s*:-\s*([A-Za-z_]\w*)/g, 'PKGOK__$1')
    .replace(new RegExp(`\\b(${PKGS})\\s*\\[\\s*([A-Za-z_]\\w*)\\s*\\](?=\\s*\\()`, 'g'), 'PKGOK__$2')
    .replace(new RegExp(`\\b(${PKGS})\\s*:-\\s*([A-Za-z_]\\w*)`, 'g'), 'PKGOK__$2');
  function cmdName(name) {
    let ok = false;
    if (name.startsWith('PKGOK__')) { name = name.slice(7); ok = true; }
    const pkgs = PKG_OF[name];
    if (pkgs && !ok && !pkgs.some(p => state.packages.has(p)) && !state.funcs.has(name) && !state.procs.has(name)) {
      const pkg = pkgs[0], shown = pkg === 'Student_MultivariateCalculus' ? 'Student[MultivariateCalculus]' : pkg;
      throw err(null, `${name} is part of the ${shown} package: load it first with  with(${shown}):  or call it as  ${shown}[${name}](...)`);
    }
    return name;
  }

  function callResult(name, args, sub) {
    if (state.procs.has(name)) return callProc(name, state.procs.get(name), args.map(a => nd(tr(a)).toString()));
    name = cmdName(name);
    if (Object.prototype.hasOwnProperty.call(CMD, name)) {
      const r = CMD[name](args, sub);
      if (r && r.plot) throw err(name, 'a plot cannot be used inside an expression');
      return r && typeof r === 'object' ? r : { value: r };
    }
    const fn = RENAME[name] || name;
    return { value: `${fn}(${args.map(tr).join(',')})` };
  }
  const callValue = (name, args, sub) => callResult(name, args, sub).value;

  /* ---------- funções como objetos (operador D) ---------- */
  const PARSER_FNS = (() => { try { return nd.getCore().PARSER.functions; } catch (e) { return {}; } })();
  function isKnownFn(name) {
    return Object.prototype.hasOwnProperty.call(CMD, name) || Object.prototype.hasOwnProperty.call(RENAME, name) ||
      state.funcs.has(name) || Object.prototype.hasOwnProperty.call(PARSER_FNS, name);
  }
  // devolve {params, body} de uma função do usuário, de uma seta x -> ... ou de uma função embutida (sin, exp…)
  function fnInfo(arg) {
    const a = arg.trim();
    const arrow = arrowFn(a);
    if (arrow) return { params: arrow.params, body: nd(tr(arrow.body)).toString() };
    if (state.funcs.has(a)) return state.funcs.get(a);
    const inner = /^D(\[[^\]]*\])?\s*\(/.test(a) ? callResult('D', splitTop(a.slice(a.indexOf('(') + 1, -1)), (a.match(/^D\[([^\]]*)\]/) || [])[1] || null) : null;
    if (inner && inner.fn) return inner.fn;
    const nm = RENAME[a] || a;
    if (/^[A-Za-z_]\w*$/.test(a) && (Object.prototype.hasOwnProperty.call(PARSER_FNS, nm) || nm === 'exp')) {
      return { params: ['x'], body: nm === 'exp' ? 'e^x' : `${nm}(x)` };
    }
    throw err('D', `${a} is not a function; define it first, e.g. ${a} := x -> x^2`);
  }
  let anonSeq = 0;
  function fnResult(params, body) {
    body = nd(body).toString();
    const fname = 'Dfn' + (++anonSeq);
    nd.setFunction(fname, params, body);
    state.funcs.set(fname, { params, body });
    const p = params.length === 1 ? params[0] : `\\left(${params.join(', ')}\\right)`;
    return { value: fname, fname, fn: { params, body }, tex: `${p} \\mapsto ${tex(body)}`, noHistory: false };
  }
  function derivTeX(fTex, vars) {
    const n = vars.length;
    if (new Set(vars).size === 1) {
      const v = vars[0];
      return n === 1 ? `\\frac{d}{d${v}}\\left(${fTex}\\right)` : `\\frac{d^{${n}}}{d${v}^{${n}}}\\left(${fTex}\\right)`;
    }
    return `\\frac{\\partial^{${n}}}{${vars.map(v => `\\partial ${v}`).join('\\,')}}\\left(${fTex}\\right)`;
  }
  function unknownCall(src) { // primeira chamada a função não definida, ex.: y(x)
    const re = /(^|[^\w])([A-Za-z_]\w*)\s*\(/g; let m;
    while ((m = re.exec(src))) if (!isKnownFn(m[2]) && !CONST[m[2]]) return m[2];
    return null;
  }
  function diffVars(args) {
    const out = [];
    for (const a of args) {
      const m = /^\s*([A-Za-z_]\w*)\s*\$\s*(\d+)\s*$/.exec(a);
      out.push(...(m ? Array(+m[2]).fill(m[1]) : listOrSet(a).map(x => x.trim())));
    }
    return out;
  }

  /* ======================= Resultados ======================= */
  // Um resultado é {value: string nerdamer, tex: string} ou {plot} ou {none:true}
  const R = (value, t) => {
    if (/factorial\(\d+\)/.test(value)) value = nd(bigFact(value)).toString();
    if (/e\^log\(/.test(value)) value = nd(fixExpLog(value)).toString();
    return { value, tex: t !== undefined ? t : prettyTex(value) };
  };
  const seqR = (itemsIn, wrap = '') => { // sequência de expressões
    const items = itemsIn;
    const t = items.map(x => (typeof x === 'string' ? tex(x) : x.tex)).join(',\\; ');
    const v = '[' + items.map(x => (typeof x === 'string' ? x : x.value)).join(',') + ']';
    const single = wrap === '' && itemsIn.length === 1;
    return { value: single ? (typeof itemsIn[0] === 'string' ? itemsIn[0] : itemsIn[0].value) : v, tex: wrap === '{' ? `\\left\\{${t}\\right\\}` : wrap === '[' ? `\\left[${t}\\right]` : t, isSeq: wrap === '', items: itemsIn.map(x => (typeof x === 'string' ? x : x.value)) };
  };

  /* ======================= Comandos ======================= */

  // estima um limite lateral numericamente e reconhece inteiros, frações simples e infinito
  function numericLimit(F) {
    const hs = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8];
    const vals = hs.map(F);
    const last = vals[vals.length - 1], prev = vals[vals.length - 2];
    if (!isFinite(last) || Math.abs(last) > 1e7 && Math.abs(last) > 5 * Math.abs(prev)) {
      const sgn = Math.sign(isFinite(last) ? last : prev) || 1;
      return sgn > 0 ? { value: 'Infinity', tex: '\\infty' } : { value: '-Infinity', tex: '-\\infty' };
    }
    for (let q = 1; q <= 64; q++) {
      const p = Math.round(last * q);
      if (Math.abs(last - p / q) < 1e-6) return R(nd(`${p}/${q}`).toString());
    }
    return { value: String(last), tex: fmtFloat(last, state.digits) };
  }
  // avalia expr para v = a, a+passo, …, b, atribuindo v de verdade (procs recebem números, como no Maple)
  function iterate(expr, v, a, b, step = 1) {
    const lo = N(a), hi = N(b);
    if (!isFinite(lo) || !isFinite(hi)) throw err(null, `the range ${v} = ${a} .. ${b} must be numeric`);
    if ((hi - lo) / step > 100000) throw err(null, 'sequence too long (more than 100000 terms)');
    const out = [];
    withVar(v, () => {
      for (let k = 0; ; k++) {
        const x = nd(`(${a})+${k}*(${step})`).toString();
        if (step > 0 ? N(x) > hi + 1e-12 : N(x) < hi - 1e-12) break;
        setUserVar(v, x);
        out.push(nd(tr(expr)).toString());
      }
    });
    return out;
  }
  function iterIn(expr, v, L) {
    const raw = resolveRaw(L);
    const items = isWrapped(raw, '[', ']') || isWrapped(raw, '{', '}') ? listOrSet(raw).map(tr) : splitTop(nd(tr(raw)).toString().replace(/^\[|\]$/g, ''));
    const out = [];
    withVar(v, () => { for (const it of items) { setUserVar(v, nd(it).toString()); out.push(nd(tr(expr)).toString()); } });
    return out;
  }
  function withVar(v, fn) { // a variável de índice volta ao estado anterior (no Maple, seq/add não deixam valor)
    const had = state.vars.has(v), old = had ? nd(vn(v)).toString() : null;
    try { fn(); } finally { if (had) setUserVar(v, old); else clearUserVar(v); }
  }
  function hasProcCall(src) { return [...String(src).matchAll(/([A-Za-z_]\w*)\s*\(/g)].some(m => state.procs.has(m[1])); }
  // integral definida: simbólica, conferida numericamente; se o motor errar ou não fechar, usa o valor numérico
  function defInt(args) {
    const { v, a, b } = parseRange(args[1], 'int');
    const f = tr(args[0]);
    let r = null;
    try {
      r = nd(`defint(${f},${a},${b},${v})`).toString();
      if (/defint|integrate/.test(r)) r = null;
    } catch (e) { r = null; }
    if (r === null) {
      try {
        const F = nd(`integrate(${f},${v})`).toString();
        if (!/integrate/.test(F)) {
          const atp = pt => (/Infinity/.test(pt) ? nd(`limit(${F},${v},${pt})`).toString() : nd(F, { [v]: `(${pt})` }).toString());
          r = nd(`simplify((${atp(b)})-(${atp(a)}))`).toString();
        }
      } catch (e) { r = null; }
    }
    if (r !== null) { try { r = simplifyInf(r); } catch (e) {} }
    // conferência numérica (só quando a integral é numérica: sem variáveis livres)
    let num = NaN;
    const free = (() => { try { return [...new Set(nd(f).variables().concat(nd(a).variables(), nd(b).variables()))].filter(x => x !== v); } catch (e) { return ['?']; } })();
    if (!free.length) { try { num = numEval(`Int(${args[0]}, ${args[1]})`, {}); } catch (e) { num = NaN; } }
    const symOk = r !== null && !/Infinity|limit|NaN|\bi\b|erf\(\s*i/.test(r) && (!isFinite(num) || (() => { try { const sv = N(r); return isFinite(sv) && Math.abs(sv - num) <= 1e-6 * (1 + Math.abs(num)); } catch (e) { return false; } })());
    if (symOk) return R(r);
    if (r !== null && free.length && !/limit|NaN/.test(r)) return R(r);
    if (isFinite(num)) return { value: String(num), tex: fmtFloat(num, state.digits) };
    if (r !== null && /Infinity/.test(r) && !isFinite(num)) return R(r);
    return R(`int(${f},${v}=${a}..${b})`, `\\int_{${tex(a)}}^{${tex(b)}} ${tex(f)}\\,d${v}`);
  }
  // frações com numerador e denominador enormes (aproximações do motor) aparecem em decimal
  function prettyTex(v) {
    const m = /^(-?)(\d{7,})\/(\d{7,})$/.exec(String(v).replace(/[()]/g, ''));
    if (m) return fmtFloat(Number(m[1] + m[2]) / Number(m[3]), state.digits);
    return tex(v);
  }
  function fixExpLog(s) {
    for (let guard = 0; guard < 20; guard++) {
      const k = s.indexOf('e^log(');
      if (k < 0) break;
      const c = matchClose(s, k + 5);
      s = s.slice(0, k) + '(' + s.slice(k + 6, c) + ')' + s.slice(c + 1);
    }
    return s;
  }
  // expand de sin/cos de somas e múltiplos: sin(a+b), cos(2*x) …
  function expandTrig(s) {
    for (let guard = 0; guard < 40; guard++) {
      const m = /\b(sin|cos)\(/.exec(s.slice(0));
      let changed = false;
      const re = /\b(sin|cos)\(/g; let mm;
      while ((mm = re.exec(s))) {
        const open = mm.index + mm[1].length, close = matchClose(s, open);
        const arg = nd(s.slice(open + 1, close)).toString();
        const terms = splitSum(arg);
        let rep = null;
        if (terms.length > 1) {
          const A = terms[0], B = terms.slice(1).join('+');
          rep = mm[1] === 'sin' ? `(sin(${A})*cos(${B})+cos(${A})*sin(${B}))` : `(cos(${A})*cos(${B})-sin(${A})*sin(${B}))`;
        } else {
          const k = /^(\d+)\*(.+)$/.exec(arg);
          if (k && +k[1] >= 2 && +k[1] <= 12) {
            const u = k[2], n1 = `${+k[1] - 1}*${u}`;
            rep = mm[1] === 'sin' ? `(sin(${u})*cos(${n1})+cos(${u})*sin(${n1}))` : `(cos(${u})*cos(${n1})-sin(${u})*sin(${n1}))`;
          }
        }
        if (rep) { s = s.slice(0, mm.index) + rep + s.slice(close + 1); changed = true; break; }
      }
      if (!changed) break;
    }
    return s;
  }
  function splitSum(a) { // termos de uma soma no nível superior
    const out = []; let depth = 0, cur = '';
    for (let i = 0; i < a.length; i++) {
      const ch = a[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && (ch === '+' || ch === '-') && i > 0 && !/[*/^(e]/.test(a[i - 1])) { out.push(cur); cur = ch === '-' ? '-' : ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.filter(t => t !== '');
  }
  function simplifyInf(s) {
    return nd(s.replace(/e\^\(-Infinity\)/g, '0').replace(/e\^\(Infinity\)/g, 'Infinity')
      .replace(/atan\(-Infinity\)/g, '(-pi/2)').replace(/atan\(Infinity\)/g, '(pi/2)')
      .replace(/erf\(-Infinity\)/g, '(-1)').replace(/erf\(Infinity\)/g, '(1)')).toString();
  }

  const CMD = {
    /* ---------- Cálculo ---------- */
    diff(args) {
      if (args.length < 2) throw err('diff', 'expecting at least 2 arguments');
      const vars = diffVars(args.slice(1));
      for (const v of vars) {
        if (state.vars.has(v)) throw err('diff', `invalid input: diff received ${nd(v).toString()}, which is not valid for its 2nd argument (use ${v} := '${v}' to unassign ${v})`);
      }
      const unk = unknownCall(preD(args[0]));
      if (unk) { // função desconhecida, ex.: diff(y(x), x) fica indicada, como no Maple
        const t = derivTeX(args[0].replace(/\*/g, '\\,'), vars);
        return { value: `d${vars.length}_${unk}`, tex: t };
      }
      let e = tr(args[0]);
      for (const v of vars) e = nd(`diff(${e},${v})`).toString();
      return R(e);
    },
    Diff(args) { // forma inerte: mostra d/dx sem calcular (value(%) calcula)
      const vars = diffVars(args.slice(1));
      const r = CMD.diff(args);
      return { value: r.value, tex: derivTeX(tex(tr(args[0])), vars) };
    },
    D(args, sub) {
      if (args.length !== 1) throw err('D', 'expecting exactly 1 argument, e.g. D(f)');
      const { params, body } = fnInfo(args[0]);
      const idx = sub ? splitTop(sub).map(i => Math.round(N(tr(i)))) : [1];
      let b = body;
      for (const i of idx) {
        const v = params[i - 1];
        if (!v) throw err('D', `index ${i} out of range: the function has ${params.length} parameter(s)`);
        b = nd(`diff(${b},${v})`).toString();
      }
      return fnResult(params, b);
    },
    implicitdiff(args) {
      const F = eqToExpr(args[0]);
      const y = args[1].trim(), x = args[2].trim();
      const Fx = nd(`diff(${F},${x})`).toString(), Fy = nd(`diff(${F},${y})`).toString();
      return R(nd(`simplify(-(${Fx})/(${Fy}))`).toString());
    },
    int(args) {
      if (!args[1]) throw err('int', 'expecting 2 arguments');
      if (isWrapped(args[1], '[', ']')) { // int(f, [x = a .. b, y = c .. d]): x por dentro
        let body = args[0];
        for (const r of listOrSet(args[1])) body = `int(${body}, ${r})`;
        return evalExpr(body);
      }
      if (/\.\./.test(args[1])) return defInt(args);
      const f = tr(args[0]);
      if (args[1].includes('..')) {
        const { v, a, b } = parseRange(args[1], 'int');
        let r = null;
        try { r = nd(`defint(${f},${a},${b},${v})`).toString(); } catch (e) { r = null; }
        if (r === null || /defint|integrate/.test(r)) {
          const F = nd(`integrate(${f},${v})`).toString();
          if (/integrate/.test(F)) return R(`int(${f},${v}=${a}..${b})`, `\\int_{${tex(a)}}^{${tex(b)}} ${tex(f)}\\,d${v}`);
          const at = pt => (/Infinity/.test(pt) ? nd(`limit(${F},${v},${pt})`).toString() : nd(F, { [v]: `(${pt})` }).toString());
          r = nd(`(${at(b)})-(${at(a)})`).toString();
        }
        return R(simplifyInf(r));
      }
      const r = nd(`integrate(${f},${args[1]})`).toString();
      if (/integrate\(/.test(r)) return R(r, `\\int ${tex(f)}\\,d${args[1]}`);
      return R(r);
    },
    limit(args) {
      const f = tr(args[0]); const e = parseEq(args[1] || '');
      if (!e) throw err('limit', 'invalid limiting point');
      const v = e.lhs.trim(), a = tr(e.rhs), dir = (args[2] || '').trim();
      const clean = r => (r === null || /^\[|limit\(/.test(r) ? null : simplifyInf(r));
      const safe = fn => { try { return clean(fn()); } catch (x) { return null; } };
      const direct = () => nd(`limit(${f},${v},${a})`).toString();
      // funções não suaves (abs, sign, floor…) travam o limite simbólico do motor: usa os limites laterais numéricos
      if (/\b(abs|sign|floor|ceil|round|trunc|max|min|piecewise)\(/.test(f) && !/Infinity/.test(nd(a).toString())) {
        const g = numFn(f, [v], 'limit'), A0 = N(a);
        const one = sg => numericLimit(h => g(A0 + sg * h));
        if (dir === 'right') return one(1);
        if (dir === 'left') return one(-1);
        const l = one(-1), r = one(1);
        return l.value === r.value ? r : { value: 'undefined', tex: '\\mathit{undefined}' };
      }
      if (/Infinity/.test(nd(a).toString())) { const d = safe(direct); return d === null ? R(`limit(${f},${v},${a})`, `\\lim_{${v} \\to ${tex(a)}} ${tex(f)}`) : R(d); }
      // limite lateral: x = a ± 1/t com t -> infinito
      const side = sg => safe(() => nd(`limit(${nd(`expand(${nd(f, { [v]: `(${a})${sg}1/(tlimvar)` }).toString()})`).toString()},tlimvar,Infinity)`).toString());
      // conferência numérica dos dois lados
      const fn = (() => { try { const g = nd(f).buildFunction([v]); return x => { try { return g(x); } catch (q) { return NaN; } }; } catch (q) { return null; } })();
      const A = N(a), h = 1e-7 * (1 + Math.abs(A));
      const near = (p, q) => isFinite(p) && isFinite(q) && Math.abs(p - q) <= 1e-4 * (1 + Math.abs(p) + Math.abs(q));
      if (dir === 'right' || dir === 'left') {
        const r = side(dir === 'right' ? '+' : '-');
        if (r !== null) return R(r);
        return R(`limit(${f},${v},${a})`, `\\lim_{${v} \\to ${tex(a)}^{${dir === 'right' ? '+' : '-'}}} ${tex(f)}`);
      }
      const L = side('-'), Rr = side('+'), d = safe(direct);
      const numL = fn ? fn(A - h) : NaN, numR = fn ? fn(A + h) : NaN;
      if (L !== null && Rr !== null && L === Rr) return R(Rr);
      if (L !== null && Rr !== null && L !== Rr && !near(numL, numR)) return { value: 'undefined', tex: '\\mathit{undefined}' };
      if (d !== null && !/Infinity/.test(d) && (!fn || near(numL, N(d)) || !isFinite(numL))) return R(d);
      if (fn && Math.abs(numL) > 1e6 && Math.abs(numR) > 1e6 && Math.sign(numL) !== Math.sign(numR)) return { value: 'undefined', tex: '\\mathit{undefined}' };
      if (d !== null) return R(d);
      return R(`limit(${f},${v},${a})`, `\\lim_{${v} \\to ${tex(a)}} ${tex(f)}`);
    },
    sum(args) {
      if (!args[1] || !args[1].includes('..')) throw err('sum', 'indefinite sums are not supported');
      const { v, a, b } = parseRange(args[1], 'sum');
      if (/Infinity/.test(nd(b).toString()) && hasProcCall(args[0])) throw err('sum', 'infinite sums of procedures: use evalf(Sum(...))');
      // com limites numéricos e chamadas de proc, soma termo a termo; senão, soma simbólica
      if (hasProcCall(args[0]) && isFinite(N(a)) && isFinite(N(b))) return R(nd(iterate(args[0], v, a, b).map(x => `(${x})`).join('+') || '0').toString());
      const term = nd(tr(args[0])).toString();
      if (/Infinity/.test(nd(b).toString())) {
        const r0 = infiniteSum(term, v, a);
        if (r0 && typeof r0 === 'object') return r0;
        if (r0) return R(r0);
        return R(`sum(${term},${v},${a},Infinity)`, `\\sum_{${v}=${tex(a)}}^{\\infty} ${tex(term)}`);
      }
      if (nd(b).variables().length || nd(a).variables().length) {
        const deg = degIn(term, v);
        const expoVar = new RegExp('\\^\\(?[^)]*\\b' + v + '\\b').test(term) || new RegExp('\\b(sin|cos|tan|exp|log|factorial)\\([^)]*\\b' + v + '\\b').test(term);
        if (deg <= 12 && !expoVar) {
          const r1 = polyInterpSum(term, v, a, b);
          if (r1) { // conferência: b = a + 7
            const free = nd(b).variables()[0];
            let ok = true;
            try {
              if (free) {
                const bb = nd(b, { [free]: '9' }).toString(), aa = nd(a, { [free]: '9' }).toString();
                let direct = '0'; for (let k = N(aa); k <= N(bb); k++) direct = nd(`(${direct})+(${nd(term, { [v]: String(k) }).toString()})`).toString();
                ok = Math.abs(N(nd(r1, { [free]: '9' }).toString()) - N(direct)) < 1e-6 * (1 + Math.abs(N(direct)));
              }
            } catch (e) { ok = false; }
            if (ok) return R(r1);
          }
        }
        // geométrica finita: c*r^k
        try {
          const rk = k => nd(`simplify((${nd(term, { [v]: String(k + 1) }).toString()})/(${nd(term, { [v]: String(k) }).toString()}))`).toString();
          const ratio = rk(2);
          if (nd(`simplify((${ratio})-(${rk(5)}))`).toString() === '0' && ratio !== '1') return R(nd(`simplify((${nd(term, { [v]: `(${a})` }).toString()})*((${ratio})^((${b})-(${a})+1)-1)/((${ratio})-1))`).toString());
        } catch (e) {}
      }
      const r = nd(`sum(${tr(args[0])},${v},${a},${b})`).toString();
      if (/^sum\(/.test(r) && isFinite(N(a)) && isFinite(N(b)) && N(b) - N(a) <= 5000) return R(nd(iterate(args[0], v, a, b).map(x => `(${x})`).join('+') || '0').toString());
      return R(r);
    },
    product(args) {
      const { v, a, b } = parseRange(args[1], 'product');
      if (isFinite(N(a)) && isFinite(N(b)) && (hasProcCall(args[0]) || N(b) - N(a) <= 5000)) return R(nd(iterate(args[0], v, a, b).map(x => `(${x})`).join('*') || '1').toString());
      return R(nd(`product(${tr(args[0])},${v},${a},${b})`).toString());
    },
    add(args) {
      if (/\bin\b/.test(args[1] || '')) { const m = /^\s*(\w+)\s+in\s+([\s\S]+)$/.exec(args[1]); return R(nd(iterIn(args[0], m[1], m[2]).map(x => `(${x})`).join('+') || '0').toString()); }
      const { v, a, b } = parseRange(args[1], 'add');
      if (!isFinite(N(a)) || !isFinite(N(b))) throw err('add', 'unable to execute add: the range must be numeric (use sum for symbolic ranges)');
      return R(nd(iterate(args[0], v, a, b).map(x => `(${x})`).join('+') || '0').toString());
    },
    mul(args) {
      if (/\bin\b/.test(args[1] || '')) { const m = /^\s*(\w+)\s+in\s+([\s\S]+)$/.exec(args[1]); return R(nd(iterIn(args[0], m[1], m[2]).map(x => `(${x})`).join('*') || '1').toString()); }
      const { v, a, b } = parseRange(args[1], 'mul');
      if (!isFinite(N(a)) || !isFinite(N(b))) throw err('mul', 'unable to execute mul: the range must be numeric (use product for symbolic ranges)');
      return R(nd(iterate(args[0], v, a, b).map(x => `(${x})`).join('*') || '1').toString());
    },
    seq(args) {
      if (args.length === 1) { // seq(a .. b)
        const k = args[0].indexOf('..'); const lo = N(tr(args[0].slice(0, k))), hi = N(tr(args[0].slice(k + 2)));
        const items = []; for (let x = lo; x <= hi + 1e-12; x++) items.push(String(x)); return seqR(items);
      }
      if (/\bin\b/.test(args[1])) { const m = /^\s*(\w+)\s+in\s+([\s\S]+)$/.exec(args[1]); return seqR(iterIn(args[0], m[1], m[2])); }
      const { v, a, b } = parseRange(args[1], 'seq');
      return seqR(iterate(args[0], v, a, b, args[2] ? N(tr(args[2])) : 1));
    },
    taylor(args) { return series(args, 'taylor'); },
    series(args) { return series(args, 'series'); },

    /* ---------- Equações ---------- */
    solve(args) {
      const eqs = listOrSet(args[0]);
      const braced = args[1] !== undefined && (isWrapped(args[1], '{', '}') || isWrapped(args[1], '[', ']'));
      let vars = args[1] !== undefined ? listOrSet(args[1]) : null;
      const exprs = eqs.map(eqToExpr);
      if (!vars) {
        vars = [...new Set(exprs.flatMap(x => nd(x).variables()))];
      }
      if (exprs.length === 1 && vars.length === 1) {
        const v = vars[0];
        const r = nd(`solve(${exprs[0]},${v})`).toString();
        const sols = splitTop(r.replace(/^\[|\]$/g, '')).filter(x => x !== '');
        if (!sols.length) return { value: '[]', tex: '\\text{(no solutions found)}' };
        if (braced || isWrapped(args[0], '{', '}')) {
          return seqR(sols.map(s => ({ value: `${v}=${s}`, tex: `\\left\\{${v} = ${tex(s)}\\right\\}` })));
        }
        const seen = new Set();
        const uniq = sols.map(prettySol).filter(x => { const k = typeof x === 'string' ? nd(x).toString() : x.tex; if (seen.has(k)) return false; seen.add(k); return true; });
        return seqR(uniq);
      }
      let sol = null;
      if (isLinearSystem(exprs, vars)) { try { sol = nd.solveEquations(exprs.map(x => `${x}=0`), vars); } catch (e) { sol = null; } }
      if (sol && sol.length && sol.length === vars.length) {
        const items = sol.map(([v, val]) => ({ value: `${v}=${val}`, tex: `${v} = ${tex(String(val))}` }));
        return seqR(items, '{');
      }
      // sistema não linear: fatoração + substituição, com várias soluções (como o Maple)
      const exprsN = exprs.map(x => nd(x).toString());
      let sols = dedupeSols(solveSys(exprsN, vars) || [], vars, exprsN);
      const realOnly = sols.filter(sl => vars.every(v => !/\bi\b/.test(nd(sl[v]).toString())));
      if (realOnly.length) sols = realOnly;
      if (!sols.length) return { value: '[]', tex: '\\text{(no solutions found)}' };
      return seqR(sols.map(sl => ({ value: `[${vars.map(v => `${v}=${sl[v]}`).join(',')}]`, tex: `\\left\\{${vars.map(v => `${tex(v)} = ${prettyTex(sl[v])}`).join(',\\; ')}\\right\\}` })));
    },
    fsolve(args) {
      const expr = eqToExpr(args[0]);
      const vars = nd(expr).variables();
      let v = vars[0] || 'x', lo = -100, hi = 100;
      if (args[1]) {
        if (args[1].includes('..')) { const r = parseRange(args[1], 'fsolve'); v = r.v; lo = N(r.a); hi = N(r.b); }
        else { const e = parseEq(args[1]); if (e) v = e.lhs.trim(); else v = args[1].trim(); }
      }
      if (vars.length > 1) throw err('fsolve', 'only single equations in one variable are supported');
      const f = nd(expr).buildFunction([v]);
      const roots = [];
      const add = x => { if (isFinite(x) && x >= lo - 1e-9 && x <= hi + 1e-9 && !roots.some(r => Math.abs(r - x) < 1e-9 * (1 + Math.abs(x)))) roots.push(x); };
      // varredura + bisseção
      const M = 4000; let px = lo, py = f(lo);
      for (let k = 1; k <= M; k++) {
        const x = lo + (hi - lo) * k / M, y = f(x);
        if (py === 0) add(px);
        if (isFinite(py) && isFinite(y) && py * y < 0) {
          let a = px, b = x, fa = py;
          for (let it = 0; it < 200; it++) { const m = (a + b) / 2, fm = f(m); if (fa * fm <= 0) b = m; else { a = m; fa = fm; } }
          const r = (a + b) / 2; if (Math.abs(f(r)) < 1e-6 * (1 + Math.abs(py) + Math.abs(y))) add(r);
        }
        px = x; py = y;
      }
      if (!roots.length) return { value: '[]', tex: '\\text{(fsolve found no real root)}' };
      roots.sort((a, b) => a - b);
      let isPoly = false; try { isPoly = nd(`deg(${expr},${v})`).toString() !== '' && !/[a-z]\(/i.test(nd(expr).toString()); } catch (e) {}
      const chosen = isPoly ? roots : [roots[0]];
      const items = chosen.map(r => ({ value: String(r), tex: fmtFloat(r, state.digits) }));
      return items.length === 1 ? items[0] : seqR(items);
    },
    lhs(args) { const e = eqParts(args[0]); return R(nd(e ? e.lhs : tr(args[0])).toString()); },
    rhs(args) { const e = eqParts(args[0]); return R(nd(e ? e.rhs : '0').toString()); },

    /* ---------- Avaliação ---------- */
    evalf(args, sub) {
      const digits = sub ? Number(N(tr(sub))) : args[1] ? Number(N(tr(args[1]))) : state.digits;
      const raw0 = args[0].trim();
      if (/^(int|Int|sum|Sum)\s*\(/.test(raw0) || (/\b(Int|Sum)\s*\(/.test(raw0))) {
        const val = numEval(raw0, {});
        if (isFinite(val)) return { value: String(val), tex: fmtFloat(val, digits) };
      }
      const v = tr(args[0]);
      if (isMatrix(v)) return R(v);
      if (/\bint\(|defint\(|sum\(/.test(v)) { const val = numEval(v.replace(/\bdefint\(/g, 'int('), {}); if (isFinite(val)) return { value: String(val), tex: fmtFloat(val, digits) }; }
      const s = evalfStr(v, digits);
      return { value: s.replace(/ 10\^\((-?\d+)\)/, 'e$1'), tex: floatTeX(s) };
    },
    subs(args) {
      const target = resolveRaw(args[args.length - 1]);
      const list = args.slice(0, -1).flatMap(a => listOrSet(resolveRaw(a)));
      const doSub = expr => {
        let e = nd(tr(expr)).toString();
        for (const sb of list) {
          const q = parseEq(sb); if (!q) throw err('subs', `invalid substitution: ${sb}`);
          e = nd(e, { [q.lhs.trim()]: `(${tr(q.rhs)})` }).toString();
        }
        return e;
      };
      if (isWrapped(target, '[', ']') || isWrapped(target, '{', '}')) return seqR(listOrSet(target).map(x => mapEq(x, doSub)), target.trim()[0]);
      return mapEq(target, doSub);
    },
    eval(args) {
      const target = resolveRaw(args[0]);
      const list = args[1] ? listOrSet(resolveRaw(args[1])) : [];
      const doEval = expr => {
        let e = nd(tr(expr)).toString();
        for (const sb of list) {
          const q = parseEq(sb); if (!q) throw err('eval', `invalid evaluation point: ${sb}`);
          e = nd(e, { [q.lhs.trim()]: `(${tr(q.rhs)})` }).toString();
        }
        return nd(e).toString();
      };
      return mapEq(target, doEval);
    },
    value(args) { return R(tr(args[0])); },
    simplify(args) { return mapEq(tr(args[0]), e => trigSimplify(nd(fixExpLog(nd(`simplify(${e})`).toString())).toString())); },
    expand(args) { return mapEq(tr(args[0]), e => nd(`expand(${expandTrig(nd(`expand(${e})`).toString())})`).toString()); },
    factor(args) { return R(nd(`factor(${tr(args[0])})`).toString()); },
    convert(args) {
      const kind = (args[1] || '').trim();
      const e = tr(args[0]);
      if (kind === 'parfrac') return R(nd(`partfrac(${e},${args[2] || nd(e).variables()[0] || 'x'})`).toString());
      if (kind === 'polynom') return R(e);
      if (kind === 'float') return CMD.evalf([args[0]]);
      if (kind === 'list' || kind === 'set') return R(e);
      if (kind === 'string') return { value: e, tex: `\\texttt{"${nd(e).toString()}"}` };
      throw err('convert', `conversion to ${kind} is not supported`);
    },
    numer(args) { return R(nd(tr(args[0])).symbol.getNum().text()); },
    denom(args) { return R(nd(tr(args[0])).symbol.getDenom().text()); },
    coeff(args) {
      const p = nd(`expand(${tr(args[0])})`).toString();
      const v = args[1].trim(); const n = args[2] !== undefined ? N(tr(args[2])) : 1;
      const cs = splitTop(nd(`coeffs(${p},${v})`).toString().replace(/^\[|\]$/g, ''));
      return R(cs[n] !== undefined ? cs[n] : '0');
    },
    collect(args) { return R(nd(`expand(${tr(args[0])})`).toString()); },

    /* ---------- Teoria dos números ---------- */
    ifactor(args) {
      const v = nd(`pfactor(${tr(args[0])})`).toString();
      const parts = [...v.matchAll(/\((\d+)(?:\^(\d+))?\)/g)].map(m => `\\left(${m[1]}\\right)${m[2] ? `^{${m[2]}}` : ''}`);
      return { value: v, tex: parts.length ? parts.join('\\,') : tex(v) };
    },
    isprime(args) {
      const n = N(tr(args[0]));
      let p = Number.isInteger(n) && n > 1;
      for (let d = 2; p && d * d <= n; d++) if (n % d === 0) p = false;
      return { value: String(p), tex: `\\mathit{${p}}` };
    },
    ithprime(args) {
      const k = N(tr(args[0])); let c = 0, n = 1;
      while (c < k) { n++; let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p) c++; }
      return R(String(n));
    },
    iquo(args) { return R(String(Math.trunc(N(tr(args[0])) / N(tr(args[1]))))); },
    binomial(args) {
      const n = tr(args[0]), k = tr(args[1]);
      if (/^\d+$/.test(nd(n).toString()) && /^\d+$/.test(nd(k).toString())) {
        const N0 = BigInt(nd(n).toString()), K0 = BigInt(nd(k).toString()); let r = 1n;
        for (let j = 1n; j <= K0; j++) r = r * (N0 - K0 + j) / j;
        return R(K0 > N0 ? '0' : r.toString());
      }
      return R(nd(`factorial(${n})/(factorial(${k})*factorial((${n})-(${k})))`).toString());
    },
    abs(args) { return R(nd(`abs(${tr(args[0])})`).toString()); },
    log(args, sub) {
      if (sub) {
        const v = nd(`log(${tr(args[0])})/log(${tr(sub)})`).toString();
        try { const x = N(v); if (Number.isInteger(+x.toFixed(12)) && Math.abs(x - Math.round(x)) < 1e-12) return R(String(Math.round(x))); } catch (e) {}
        return R(v);
      }
      return R(nd(`log(${tr(args[0])})`).toString());
    },
    log10(args) { return R(nd(`log(${tr(args[0])})/log(10)`).toString()); },
    exp(args) { return R(nd(`e^(${tr(args[0])})`).toString()); },

    /* ---------- Álgebra linear ---------- */
    Determinant(args) {
      const A = tr(args[0]);
      const rows = toRows(A);
      const symbolic = rows.some(r => r.some(x => nd(x).variables().length));
      if (!symbolic) return R(nd(`determinant(${A})`).toString());
      return R(trigSimplify(nd(`expand(${detSym(rows)})`).toString()));
    },
    Matrix(args) {
      if (args.length === 1 && isWrapped(args[0], '[', ']')) {
        const rows = splitTop(unwrap(args[0])).map(r => '[' + listOrSet(r).map(tr).join(',') + ']');
        return R(`matrix(${rows.join(',')})`);
      }
      const m = N(tr(args[0])), n = args[1] && !args[1].includes('=') && !isWrapped(args[1], '[', ']') ? N(tr(args[1])) : m;
      const rest = args.slice(args[1] && !args[1].includes('=') && !isWrapped(args[1], '[', ']') ? 2 : 1);
      const init = rest.find(a => isWrapped(a, '[', ']'));
      const shape = rest.find(a => /shape\s*=\s*identity/.test(a));
      const flat = init ? listOrSet(init).flatMap(r => listOrSet(r)) : [];
      const rows = [];
      for (let i = 0; i < m; i++) {
        const row = [];
        for (let j = 0; j < n; j++) row.push(shape ? (i === j ? '1' : '0') : flat.length ? tr(flat[i * n + j] || '0') : '0');
        rows.push('[' + row.join(',') + ']');
      }
      return R(`matrix(${rows.join(',')})`);
    },
    Vector(args) {
      const items = args.length === 1 && isWrapped(args[0], '[', ']') ? listOrSet(args[0]) : Array.from({ length: N(tr(args[0])) }, () => '0');
      return R(`matrix(${items.map(x => `[${tr(x)}]`).join(',')})`);
    },
    DotProduct(args) {
      const a = toList(tr(args[0])), b = toList(tr(args[1]));
      return R(nd(a.map((x, i) => `(${x})*(${b[i]})`).join('+')).toString());
    },
    CrossProduct(args) {
      const [a1, a2, a3] = toList(tr(args[0])), [b1, b2, b3] = toList(tr(args[1]));
      const c = [`(${a2})*(${b3})-(${a3})*(${b2})`, `(${a3})*(${b1})-(${a1})*(${b3})`, `(${a1})*(${b2})-(${a2})*(${b1})`].map(x => nd(x).toString());
      return R(`matrix(${c.map(x => `[${x}]`).join(',')})`);
    },
    Trace(args) {
      const A = tr(args[0]); const [m] = matSize(A);
      return R(nd(Array.from({ length: m }, (_, i) => `matget(${A},${i},${i})`).join('+')).toString());
    },
    CharacteristicPolynomial(args) {
      const lam = (args[1] || 'lambda').trim();
      return R(charPoly(tr(args[0]), lam));
    },
    Eigenvalues(args) {
      const A = tr(args[0]); const [m] = matSize(A);
      const p = charPoly(A, 'lambda');
      const sols = splitTop(nd(`solve(${p},lambda)`).toString().replace(/^\[|\]$/g, ''));
      const full = [];
      for (const s of sols) { // multiplicidade
        let mult = 1, q = p;
        try {
          for (;;) {
            const dq = nd(`diff(${q},lambda)`).toString();
            if (mult >= m || nd(`simplify(${nd(dq, { lambda: `(${s})` }).toString()})`).toString() !== '0') break;
            q = dq; mult++;
          }
        } catch (e) {}
        for (let k = 0; k < mult; k++) full.push(s);
      }
      return R(`matrix(${full.slice(0, m).map(x => `[${x}]`).join(',')})`);
    },
    Rank(args) {
      const rows = toRows(tr(args[0])).map(r => r.map(x => N(x)));
      let rank = 0; const m = rows.length, n = rows[0].length;
      for (let c = 0, r = 0; c < n && r < m; c++) {
        let p = r; for (let i = r + 1; i < m; i++) if (Math.abs(rows[i][c]) > Math.abs(rows[p][c])) p = i;
        if (Math.abs(rows[p][c]) < 1e-10) continue;
        [rows[r], rows[p]] = [rows[p], rows[r]];
        for (let i = r + 1; i < m; i++) { const f = rows[i][c] / rows[r][c]; for (let j = c; j < n; j++) rows[i][j] -= f * rows[r][j]; }
        r++; rank++;
      }
      return R(String(rank));
    },
    LinearSolve(args) {
      const A = tr(args[0]), b = tr(args[1]);
      return R(nd(`invert(${A})*(${b})`).toString());
    },
    RowDimension(args) { return R(String(matSize(tr(args[0]))[0])); },
    ColumnDimension(args) { return R(String(matSize(tr(args[0]))[1])); },

    /* ---------- Transformadas (pacote inttrans) ---------- */
    laplace(args) { return R(nd(`laplace(${tr(args[0])},${args[1].trim()},${args[2].trim()})`).toString()); },
    invlaplace(args) { return R(nd(`ilt(${tr(args[0])},${args[1].trim()},${args[2].trim()})`).toString()); },

    /* ---------- Sessão ---------- */
    with(args) {
      const pkg = args[0].trim().replace(/^Student\s*\[\s*MultivariateCalculus\s*\]$/, 'Student_MultivariateCalculus').replace(/^Student\s*:-\s*MultivariateCalculus$/, 'Student_MultivariateCalculus');
      const EXPORTS = {
        LinearAlgebra: ['CharacteristicPolynomial', 'ColumnDimension', 'CrossProduct', 'Determinant', 'DotProduct', 'Eigenvalues', 'IdentityMatrix', 'LinearSolve', 'MatrixInverse', 'Rank', 'RowDimension', 'Trace', 'Transpose'],
        inttrans: ['invlaplace', 'laplace'],
        VectorCalculus: ['Curl', 'DirectionalDiff', 'Divergence', 'Gradient', 'Hessian', 'Jacobian', 'Laplacian', 'SetCoordinates', 'VectorField'],
        Student_MultivariateCalculus: ['CriticalPoints', 'DirectionalDerivative', 'Gradient', 'Hessian', 'Jacobian', 'LagrangeMultipliers', 'MultiInt', 'SecondDerivativeTest', 'TangentPlane', 'TaylorApproximation'],
        linalg: ['curl', 'det', 'diverge', 'grad', 'hessian', 'inverse', 'jacobian', 'laplacian', 'transpose'],
        plots: ['animate', 'contourplot', 'densityplot', 'display', 'fieldplot', 'gradplot', 'implicitplot', 'implicitplot3d', 'inequal', 'intersectplot', 'logplot', 'loglogplot', 'odeplot', 'pointplot', 'pointplot3d', 'polarplot', 'semilogplot', 'spacecurve', 'textplot'],
        student: [], Student: [],
      };
      if (!EXPORTS[pkg]) throw err('with', `invalid input: ${pkg} is not a supported package`);
      state.packages.add(pkg);
      return { value: '[]', tex: `\\left[${EXPORTS[pkg].map(x => `\\mathit{${x}}`).join(',\\, ')}\\right]` };
    },
    unassign(args) {
      for (const a of args) { const n = a.replace(/'/g, '').trim(); try { nd.setVar(n, 'delete'); } catch (e) {} state.vars.delete(n); state.eqs.delete(n); state.funcs.delete(n); }
      return { none: true };
    },
    print(args) { return R(tr(args[0])); },
    lprint(args) { const v = tr(args[0]); return { value: v, tex: `\\texttt{${nd(v).toString().replace(/([_^{}%#&$])/g, '\\$1')}}` }; },
    nops(args) { const v = nd(tr(args[0])).toString(); return R(String(v.startsWith('[') ? splitTop(v.slice(1, -1)).length : 1)); },
    max(args) { return R(nd(`max(${args.map(tr).join(',')})`).toString()); },
    min(args) { return R(nd(`min(${args.map(tr).join(',')})`).toString()); },
    dsolve() { throw err('dsolve', 'differential equations are not supported by this engine yet'); },
  };
  // sinônimos do próprio Maple
  Object.assign(CMD, {
    inverse: CMD.MatrixInverse,
    Int(a) {
      const r = CMD.int(a); const f = sideR(a[0]).tex;
      if (a[1] && a[1].includes('..')) { const g = parseRange(a[1], 'Int'); return { value: r.value, tex: `\\int_{${tex(g.a)}}^{${tex(g.b)}} ${f}\\,d${g.v}` }; }
      return { value: r.value, tex: `\\int ${f}\\,d${(a[1] || 'x').trim()}` };
    },
    Sum(a) { const r = CMD.sum(a), g = parseRange(a[1], 'Sum'); return { value: r.value, tex: `\\sum_{${g.v}=${tex(g.a)}}^{${tex(g.b)}} ${tex(tr(a[0]))}` }; },
    Product(a) { const r = CMD.product(a), g = parseRange(a[1], 'Product'); return { value: r.value, tex: `\\prod_{${g.v}=${tex(g.a)}}^{${tex(g.b)}} ${tex(tr(a[0]))}` }; },
    Limit(a) { const r = CMD.limit(a), e = parseEq(a[1]); return { value: r.value, tex: `\\lim_{${e.lhs.trim()} \\to ${tex(tr(e.rhs))}} ${tex(tr(a[0]))}` }; },
  });

  function series(args, name) {
    const f = nd(tr(args[0])).toString();
    let v = 'x', a = '0';
    const e = parseEq(args[1] || 'x');
    if (e) { v = e.lhs.trim(); a = tr(e.rhs); } else v = (args[1] || 'x').trim();
    const n = args[2] !== undefined ? N(tr(args[2])) : 6;
    let deriv = f, fact = 1; const terms = [], texParts = [];
    const base = a === '0' ? v : `\\left(${v}-${tex(a)}\\right)`;
    for (let k = 0; k < n; k++) {
      if (k > 0) fact *= k;
      const val = nd(`simplify(${nd(deriv, { [v]: `(${a})` }).toString()})`).toString();
      if (val !== '0') {
        const c = nd(`(${val})/${fact}`).toString();
        terms.push(`(${c})*(${v}-(${a}))^${k}`);
        let ct = tex(c), neg = ct.startsWith('-');
        if (neg) ct = ct.slice(1);
        if (/[+-]/.test(ct.replace(/^-/, '').replace(/\{[^}]*\}/g, ''))) ct = `\\left(${ct}\\right)`;
        const pw = k === 0 ? '' : k === 1 ? base : `${base}^{${k}}`;
        const body = k === 0 ? ct : ct === '1' ? pw : `${ct}\\,${pw}`;
        texParts.push((neg ? '-' : texParts.length ? '+' : '') + body);
      }
      deriv = nd(`diff(${deriv},${v})`).toString();
    }
    const poly = terms.length ? nd(terms.join('+')).toString() : '0';
    return { value: poly, tex: `${texParts.join('') || '0'} + O\\left(${base}^{${n}}\\right)` };
  }

  // raízes numéricas aproximadas viram decimais (o motor devolve frações enormes)
  function prettySol(sv) {
    try {
      if (/\d{7,}/.test(sv) && !nd(sv).variables().length) return { value: sv, tex: fmtFloat(N(sv), state.digits) };
    } catch (e) {}
    return sv;
  }
  function eqParts(arg) { // equação literal, guardada em variável ou vinda do histórico
    let s = tr(arg).trim();
    while (isWrapped(s, '(', ')')) s = unwrap(s);
    const e = parseEq(s);
    return e ? { lhs: tr(e.lhs), rhs: tr(e.rhs) } : null;
  }

  function detSym(rows) {
    const n = rows.length;
    if (n === 1) return rows[0][0];
    if (n === 2) return `(${rows[0][0]})*(${rows[1][1]})-(${rows[0][1]})*(${rows[1][0]})`;
    const terms = [];
    for (let j = 0; j < n; j++) {
      if (rows[0][j] === '0') continue;
      const minor = rows.slice(1).map(r => r.filter((_, c) => c !== j));
      terms.push(`${j % 2 ? '-' : '+'}(${rows[0][j]})*(${detSym(minor)})`);
    }
    return terms.join('') || '0';
  }
  function charPoly(A, lam) {
    const rows = toRows(A).map((r, i) => r.map((x, j) => i === j ? `${lam}-(${x})` : `-(${x})`));
    return nd(`expand(${detSym(rows)})`).toString();
  }
  function toList(m) {
    const s = nd(m).toString();
    if (s.startsWith('matrix(')) return toRows(s).map(r => r.join(',')).flatMap(r => splitTop(r));
    return splitTop(s.replace(/^\[|\]$/g, ''));
  }
  function toRows(m) {
    const s = nd(m).toString();
    const inner = s.slice('matrix('.length, -1);
    return splitTop(inner).map(r => splitTop(r.replace(/^\[|\]$/g, '')));
  }
  function matSize(m) { const r = toRows(m); return [r.length, r[0].length]; }

  /* ======================= Gráficos: plot, plot3d e pacote plots ======================= */

  const PLOT_OPTS = new Set(['view', 'title', 'color', 'colour', 'labels', 'legend', 'style', 'thickness', 'linestyle', 'numpoints',
    'discont', 'gridlines', 'axes', 'scaling', 'coords', 'symbol', 'symbolsize', 'grid', 'filled', 'contours', 'font', 'titlefont',
    'labelfont', 'caption', 'size', 'transparency', 'colorscheme', 'orientation', 'insequence', 'frames', 'background', 'axis',
    'tickmarks', 'resolution', 'adaptive', 'sample', 'smartview', 'shading', 'lightmodel', 'connect', 'arrows', 'fieldstrength',
    'numcontours', 'optionsfeasible', 'optionsexcluded', 'optionsopen', 'optionsclosed', 'paraminfo', 'background']);
  const MAPLE_COLORS = ['#c40000', '#0000c4', '#008000', '#c400c4', '#00a0a0', '#c47a00', '#404040'];
  function colorName(c) {
    c = String(c).replace(/"/g, '').trim();
    const map = { red: '#c40000', blue: '#0000c4', green: '#008000', black: '#000000', magenta: '#c400c4', cyan: '#00a0a0', orange: '#ff8c00',
      purple: '#800080', brown: '#8b4513', gold: '#d4a017', navy: '#000080', gray: '#808080', grey: '#808080', yellow: '#d4c400', white: '#ffffff',
      pink: '#ff69b4', violet: '#8a2be2', maroon: '#800000', coral: '#ff7f50', khaki: '#bdb76b', aquamarine: '#20b2aa', turquoise: '#40e0d0' };
    return map[c.toLowerCase()] || c;
  }
  const listOpt = v => (v ? listOrSet(v) : []);
  function labelOpt(opts, i, dflt) { const l = listOpt(opts.named.labels); return l[i] ? strVal(l[i]) : dflt; }
  function parseOpts(args) {
    const ranges = [], named = {};
    for (const a of args) {
      const e = parseEq(a);
      const key = e ? e.lhs.trim() : null;
      if (key && PLOT_OPTS.has(key)) { named[key] = e.rhs.trim(); continue; }
      if (a.includes('..') && /^\s*[A-Za-z_]\w*\s*=/.test(a)) { ranges.push(parseRange(a)); continue; }
      if (!e && a.includes('..')) { const k = a.indexOf('..'); ranges.push({ v: null, a: tr(a.slice(0, k)), b: tr(a.slice(k + 2)) }); continue; }
      if (e) named[key] = e.rhs.trim();
      else named[a.trim()] = 'true';
    }
    return { ranges, named };
  }
  // função numérica segura de uma expressão Maple
  function numFn(expr, vars, where = 'plot') {
    let s = expr.trim();
    if (state.funcs.has(s) || Object.prototype.hasOwnProperty.call(PARSER_FNS, RENAME[s] || s)) s = `${s}(${vars.join(',')})`;
    const str = nd(tr(s)).toString();
    let f;
    try { f = nd(str).buildFunction(vars); }
    catch (e) {
      const free = nd(str).variables().filter(v => !vars.includes(v));
      throw err(where, free.length ? `unable to evaluate the function to numeric values: ${free.join(', ')} has no value (assign it first, e.g. ${free[0]} := 1)` : `cannot evaluate ${expr} numerically`);
    }
    // caminho lento (avalia pelo motor) para funções que ele não compila, como floor e ceil
    const slow = (...a) => { try { const sub = {}; vars.forEach((v, k) => { sub[v] = String(a[k]); }); return Number(nd(str, sub).evaluate().text('decimals')); } catch (e) { return NaN; } };
    const fast = (...a) => { try { const y = f(...a); return typeof y === 'number' ? y : NaN; } catch (e) { return NaN; } };
    const probe = vars.map((_, k) => 0.37 + k * 0.11);
    return isNaN(fast(...probe)) && !isNaN(slow(...probe)) ? slow : fast;
  }
  const isNameOfFn = s => state.funcs.has(s.trim()) || Object.prototype.hasOwnProperty.call(PARSER_FNS, RENAME[s.trim()] || s.trim());
  function mainVar(exprs, dflt = 'x') {
    for (const f of exprs) { if (isNameOfFn(f)) continue; try { const v = nd(tr(f)).variables(); if (v.length) return v[0]; } catch (e) {} }
    return dflt;
  }
  const linspace = (a, b, n) => Array.from({ length: n + 1 }, (_, k) => a + (b - a) * k / n);
  function lineStyle(opts, idx) {
    const colors = listOpt(opts.named.color || opts.named.colour);
    const thick = listOpt(opts.named.thickness), dash = listOpt(opts.named.linestyle);
    const c = colors[idx] !== undefined ? colors[idx] : colors.length === 1 ? colors[0] : null;
    const w = thick[idx] !== undefined ? thick[idx] : thick[0];
    const d = dash[idx] !== undefined ? dash[idx] : dash[0];
    const DASH = { solid: 'solid', dash: 'dash', dot: 'dot', dashdot: 'dashdot', longdash: 'longdash', spacedash: 'dash', spacedot: 'dot' };
    return { color: c ? colorName(c) : MAPLE_COLORS[idx % MAPLE_COLORS.length], width: w !== undefined ? Math.max(1, N(tr(w)) + 1) : 2, dash: d ? DASH[d.replace(/"/g, '')] || 'solid' : 'solid' };
  }
  const SYMBOLS = { circle: 'circle-open', solidcircle: 'circle', box: 'square-open', solidbox: 'square', diamond: 'diamond-open', soliddiamond: 'diamond', cross: 'x-thin-open', diagonalcross: 'x', point: 'circle', asterisk: 'asterisk-open', triangle: 'triangle-up-open' };
  function markerStyle(opts, idx) {
    const st = lineStyle(opts, idx);
    const sym = opts.named.symbol ? SYMBOLS[opts.named.symbol.replace(/"/g, '')] || 'circle' : 'diamond-open';
    const size = opts.named.symbolsize ? N(tr(opts.named.symbolsize)) / 1.6 : 8;
    return { color: st.color, symbol: sym, size, line: { color: st.color, width: 1.5 } };
  }
  function legendOf(opts, idx, dflt) { const l = listOpt(opts.named.legend); return l[idx] !== undefined ? strVal(l[idx]).replace(/^"|"$/g, '') : dflt; }
  function rangeOf(r, where) {
    const a = N(r.a), b = N(r.b);
    if (!isFinite(a) || !isFinite(b)) throw err(where, `the range ${r.v || ''} = ${r.a} .. ${r.b} must be finite numbers`);
    return [a, b];
  }
  function viewOpt(opts) {
    if (!opts.named.view) return null;
    const v = opts.named.view.trim();
    const parts = isWrapped(v, '[', ']') ? listOrSet(v) : [null, v];
    const pr = p => { if (!p || p === 'DEFAULT') return null; const k = p.indexOf('..'); return k < 0 ? null : [N(tr(p.slice(0, k))), N(tr(p.slice(k + 2)))]; };
    return { x: pr(parts[0]), y: pr(parts[1]) };
  }
  function base2D(opts, xlab, ylab, traces) {
    const grid = opts.named.gridlines !== 'false';
    const L = {
      xaxis: { title: { text: labelOpt(opts, 0, xlab) }, showgrid: grid, zeroline: true },
      yaxis: { title: { text: labelOpt(opts, 1, ylab) }, showgrid: grid, zeroline: true },
      showlegend: !!opts.named.legend,
    };
    if (opts.named.title) L.title = { text: strVal(opts.named.title), font: { size: 15 } };
    if (opts.named.scaling === 'constrained') { L.yaxis.scaleanchor = 'x'; L.yaxis.scaleratio = 1; }
    if (opts.named.axes === 'none') { L.xaxis.visible = false; L.yaxis.visible = false; }
    if (opts.named.axes === 'boxed' || opts.named.axes === 'frame') { L.xaxis.mirror = true; L.yaxis.mirror = true; L.xaxis.showline = true; L.yaxis.showline = true; L.xaxis.zeroline = false; L.yaxis.zeroline = false; }
    const v = viewOpt(opts);
    if (v && v.x) L.xaxis.range = v.x;
    if (v && v.y) L.yaxis.range = v.y;
    return L;
  }
  function base3D(opts, labs) {
    const axes = opts.named.axes || 'frame';
    const ax = i => ({ title: { text: labelOpt(opts, i, labs[i]) }, visible: axes !== 'none', showbackground: axes === 'boxed', showline: true });
    const L = { scene: { xaxis: ax(0), yaxis: ax(1), zaxis: ax(2), aspectmode: opts.named.scaling === 'constrained' ? 'data' : 'cube', camera: { eye: { x: 1.55, y: -1.55, z: 1.05 } } } };
    if (opts.named.title) L.title = { text: strVal(opts.named.title), font: { size: 15 } };
    return L;
  }
  // amostra y = f(x), quebrando a linha em descontinuidades e escolhendo uma janela vertical razoável (como o smartview do Maple)
  function sample2D(fn, a, b, n, opts) {
    const xs = linspace(a, b, n), ys = xs.map(x => { const y = fn(x); return isFinite(y) ? y : null; });
    if (!ys.some(y => y !== null)) throw err('plot', 'Warning, unable to evaluate the function to numeric values in the region; see the plotting command\'s help page to ensure the calling sequence is correct');
    const finite = ys.filter(y => y !== null).sort((p, q) => p - q);
    const q = p => finite[Math.min(finite.length - 1, Math.max(0, Math.floor(p * (finite.length - 1))))];
    const lo = q(0.02), hi = q(0.98), span = Math.max(hi - lo, 1e-9);
    let clip = null;
    if (finite[0] < lo - 4 * span || finite[finite.length - 1] > hi + 4 * span) clip = [lo - 0.6 * span, hi + 0.6 * span];
    const X = [], Y = [];
    for (let k = 0; k < ys.length; k++) {
      if (k > 0 && ys[k] !== null && ys[k - 1] !== null && (opts.named.discont === 'true' || clip) &&
          Math.abs(ys[k] - ys[k - 1]) > 2 * span && Math.sign(ys[k]) !== Math.sign(ys[k - 1])) { X.push((xs[k] + xs[k - 1]) / 2); Y.push(null); }
      X.push(xs[k]); Y.push(ys[k]);
    }
    return { x: X, y: Y, clip };
  }
  function plotResult(data, layout, extra = {}) { return { plot: Object.assign({ data, layout }, extra) }; }

  const PLOTS = {
    plot(args) {
      if (!args.length) throw err('plot', 'expecting at least 1 argument');
      const opts = parseOpts(args.slice(1));
      const n = opts.named.numpoints ? Math.max(50, N(tr(opts.named.numpoints))) : 600;
      const first = args[0].trim();
      let items = isWrapped(first, '[', ']') || isWrapped(first, '{', '}') ? listOrSet(first) : [first];
      // plot([x(t), y(t), t = a .. b]) paramétrico
      const isParam = arr => arr.length === 3 && /\.\./.test(arr[2]) && /=/.test(arr[2]);
      const isPoints = arr => arr.length && arr.every(p => isWrapped(p, '[', ']') && listOrSet(p).length === 2 && !/\.\./.test(p));
      let groups;
      if (isParam(items)) groups = [{ kind: 'param', parts: items }];
      else if (isPoints(items)) groups = [{ kind: 'points', pts: items }];
      else groups = items.map(it => isWrapped(it, '[', ']') && isParam(listOrSet(it)) ? { kind: 'param', parts: listOrSet(it) } : { kind: 'fn', f: it });
      const polar = opts.named.coords === 'polar';
      const traces = []; let clip = null, xlab = 'x';
      const rng = opts.ranges[0];
      groups.forEach((g, idx) => {
        const style = lineStyle(opts, idx);
        const pointStyle = /point/.test(opts.named.style || '');
        const tr0 = { type: 'scatter', mode: pointStyle ? 'markers' : 'lines', line: { color: style.color, width: style.width, dash: style.dash } };
        if (pointStyle) tr0.marker = markerStyle(opts, idx);
        if (g.kind === 'param') {
          const r = parseRange(g.parts[2], 'plot'), [a, b] = rangeOf(r, 'plot');
          const fx = numFn(g.parts[0], [r.v]), fy = numFn(g.parts[1], [r.v]);
          const ts = linspace(a, b, n);
          Object.assign(tr0, { x: ts.map(fx), y: ts.map(fy), name: legendOf(opts, idx, `[${g.parts[0]}, ${g.parts[1]}]`) });
        } else if (g.kind === 'points') {
          const pts = g.pts.map(p => listOrSet(p).map(c => N(tr(c))));
          Object.assign(tr0, { x: pts.map(p => p[0]), y: pts.map(p => p[1]), name: legendOf(opts, idx, 'pontos') });
        } else {
          const v = rng && rng.v ? rng.v : mainVar([g.f], polar ? 'theta' : 'x');
          xlab = v;
          const [a, b] = rng ? rangeOf(rng, 'plot') : polar ? [0, 2 * Math.PI] : [-10, 10];
          const fn = numFn(g.f, [v]);
          if (polar) {
            const ts = linspace(a, b, n);
            Object.assign(tr0, { x: ts.map(t => fn(t) * Math.cos(t)), y: ts.map(t => fn(t) * Math.sin(t)) });
          } else {
            const s = sample2D(fn, a, b, n, opts);
            Object.assign(tr0, { x: s.x, y: s.y });
            if (s.clip) clip = clip ? [Math.min(clip[0], s.clip[0]), Math.max(clip[1], s.clip[1])] : s.clip;
          }
          tr0.name = legendOf(opts, idx, g.f);
        }
        traces.push(tr0);
      });
      const L = base2D(opts, polar ? '' : xlab, '', traces);
      if (polar) { L.yaxis.scaleanchor = 'x'; L.yaxis.scaleratio = 1; }
      if (opts.ranges[1]) L.yaxis.range = rangeOf(opts.ranges[1], 'plot');
      else if (!L.yaxis.range && clip) L.yaxis.range = clip;
      return plotResult(traces, L);
    },

    plot3d(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('plot3d', 'expecting ranges for both variables, e.g. x = -2 .. 2, y = -2 .. 2');
      const first = args[0].trim();
      const list = isWrapped(first, '[', ']') || isWrapped(first, '{', '}') ? listOrSet(first) : [first];
      const G = opts.named.grid ? N(tr(listOpt(opts.named.grid)[0])) : 50;
      const [x0, x1] = rangeOf(rx, 'plot3d'), [y0, y1] = rangeOf(ry, 'plot3d');
      const us = linspace(x0, x1, G), vs = linspace(y0, y1, G);
      const vx = rx.v || 'x', vy = ry.v || 'y';
      const surf = (fz, fx, fy, idx) => {
        const X = [], Y = [], Z = [];
        for (const v of vs) {
          X.push(us.map(u => fx ? fx(u, v) : u)); Y.push(us.map(u => fy ? fy(u, v) : v));
          Z.push(us.map(u => { const z = fz(u, v); return isFinite(z) ? z : null; }));
        }
        const c = listOpt(opts.named.color)[idx];
        const t = { type: 'surface', x: X, y: Y, z: Z, showscale: false, colorscale: c ? [[0, colorName(c)], [1, colorName(c)]] : idx ? 'Blues' : 'Viridis' };
        if (/wireframe/.test(opts.named.style || '')) Object.assign(t, { hidesurface: true, contours: { x: { show: true, highlight: false }, y: { show: true, highlight: false } } });
        if (opts.named.transparency) t.opacity = 1 - N(tr(opts.named.transparency));
        return t;
      };
      let data;
      const coords = (opts.named.coords || '').replace(/\[.*$/, '');
      if (coords === 'spherical' || coords === 'cylindrical') {
        const Rf = numFn(list[0], [vx, vy], 'plot3d');
        // esféricas (Maple): r(θ, φ) com θ a primeira faixa, φ a segunda; cilíndricas: r(θ, z)
        const fx = coords === 'spherical' ? (u, w) => Rf(u, w) * Math.sin(w) * Math.cos(u) : (u, w) => Rf(u, w) * Math.cos(u);
        const fy = coords === 'spherical' ? (u, w) => Rf(u, w) * Math.sin(w) * Math.sin(u) : (u, w) => Rf(u, w) * Math.sin(u);
        const fz = coords === 'spherical' ? (u, w) => Rf(u, w) * Math.cos(w) : (u, w) => w;
        data = [surf(fz, fx, fy, 0)];
        return plotResult(data, Object.assign(base3D(opts, ['x', 'y', 'z']), {}), { is3d: true });
      }
      if (list.length === 3 && isWrapped(first, '[', ']') && !list.some(isNameOfFn)) {
        data = [surf(numFn(list[2], [vx, vy], 'plot3d'), numFn(list[0], [vx, vy], 'plot3d'), numFn(list[1], [vx, vy], 'plot3d'), 0)];
      } else {
        data = list.map((f, i) => surf(numFn(f, [vx, vy], 'plot3d'), null, null, i));
      }
      return plotResult(data, base3D(opts, [vx, vy, '']), { is3d: true });
    },

    /* ---------- pacote plots ---------- */
    display(args) {
      const opts = parseOpts(args.filter(a => { const e = parseEq(a); return e && PLOT_OPTS.has(e.lhs.trim()); }));
      const plots = [];
      const collect = a => {
        a = a.trim();
        if (isWrapped(a, '[', ']') || isWrapped(a, '{', '}')) { listOrSet(a).forEach(collect); return; }
        if (state.plots.has(a)) { plots.push(state.plots.get(a)); return; }
        let r;
        try { r = evalExpr(a); } catch (e) { throw e; }
        if (!r || !r.plot) throw err('display', `expecting plot structures but received ${a}`);
        plots.push(r.plot);
      };
      args.filter(a => { const e = parseEq(a); return !(e && PLOT_OPTS.has(e.lhs.trim())); }).forEach(collect);
      if (!plots.length) throw err('display', 'expecting at least one plot');
      const is3d = plots.some(p => p.is3d);
      if (is3d && plots.some(p => !p.is3d)) throw err('display', 'cannot display 2-D and 3-D plots together');
      if (opts.named.insequence === 'true') return animateFrom(plots.map(p => p.data), plots[0].layout, plots.map((_, i) => String(i + 1)), is3d);
      const data = plots.flatMap(p => p.data.map(t => Object.assign({}, t)));
      const layout = JSON.parse(JSON.stringify(plots[0].layout));
      if (!is3d) {
        const ys = plots.map(p => p.layout.yaxis && p.layout.yaxis.range).filter(Boolean);
        if (ys.length) layout.yaxis.range = [Math.min(...ys.map(r => r[0])), Math.max(...ys.map(r => r[1]))];
        layout.showlegend = !!opts.named.legend || plots.some(p => p.layout.showlegend);
        if (opts.named.legend) listOpt(opts.named.legend).forEach((l, i) => { if (data[i]) data[i].name = strVal(l); });
        const o = base2D(opts, '', '', data);
        if (opts.named.title) layout.title = o.title;
        if (opts.named.labels) { layout.xaxis.title = o.xaxis.title; layout.yaxis.title = o.yaxis.title; }
        if (o.xaxis.range) layout.xaxis.range = o.xaxis.range;
        if (o.yaxis.range) layout.yaxis.range = o.yaxis.range;
        if (opts.named.scaling === 'constrained') { layout.yaxis.scaleanchor = 'x'; layout.yaxis.scaleratio = 1; }
        if (opts.named.gridlines) { layout.xaxis.showgrid = o.xaxis.showgrid; layout.yaxis.showgrid = o.yaxis.showgrid; }
      } else if (opts.named.title) layout.title = { text: strVal(opts.named.title), font: { size: 15 } };
      return plotResult(data, layout, { is3d });
    },

    implicitplot(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('implicitplot', 'expecting ranges for both variables, e.g. x = -2 .. 2, y = -2 .. 2');
      const eqs = isWrapped(args[0], '[', ']') || isWrapped(args[0], '{', '}') ? listOrSet(args[0]) : [args[0]];
      const G = opts.named.grid ? N(tr(listOpt(opts.named.grid)[0])) : 160;
      const [x0, x1] = rangeOf(rx, 'implicitplot'), [y0, y1] = rangeOf(ry, 'implicitplot');
      const xs = linspace(x0, x1, G), ys = linspace(y0, y1, G);
      const traces = eqs.map((e, idx) => {
        const F = numFn(eqToExpr(e), [rx.v, ry.v], 'implicitplot');
        const z = ys.map(y => xs.map(x => { const v = F(x, y); return isFinite(v) ? v : null; }));
        const st = lineStyle(opts, idx);
        if (opts.named.filled === 'true') {
          return { type: 'contour', x: xs, y: ys, z, showscale: false, contours: { start: -1e300, end: 0, size: 1e300, coloring: 'heatmap' }, colorscale: [[0, st.color], [1, '#ffffff']], opacity: 0.5, name: legendOf(opts, idx, e) };
        }
        return { type: 'contour', x: xs, y: ys, z, showscale: false, contours: { start: 0, end: 0, size: 1, coloring: 'lines' },
          colorscale: [[0, st.color], [1, st.color]], line: { width: st.width, dash: st.dash }, name: legendOf(opts, idx, e), showlegend: !!opts.named.legend, hoverinfo: 'skip' };
      });
      const L = base2D(opts, rx.v, ry.v, traces);
      L.xaxis.range = [x0, x1]; L.yaxis.range = [y0, y1];
      return plotResult(traces, L);
    },

    implicitplot3d(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry, rz] = opts.ranges;
      if (!rx || !ry || !rz) throw err('implicitplot3d', 'expecting ranges for x, y and z');
      // aceita uma superfície ou uma lista/conjunto delas: implicitplot3d([y = -13, y = 13], ...)
      const eqs = isWrapped(args[0], '[', ']') || isWrapped(args[0], '{', '}') ? listOrSet(args[0]) : [args[0]];
      const G = 30;
      const [a0, a1] = rangeOf(rx), [b0, b1] = rangeOf(ry), [c0, c1] = rangeOf(rz);
      const xs = linspace(a0, a1, G), ys = linspace(b0, b1, G), zs = linspace(c0, c1, G);
      const colors = listOpt(opts.named.color);
      const PALETTE3D = ['#d9a400', '#3c78d8', '#6aa84f', '#c27ba0', '#e69138', '#45818e'];
      const data = eqs.map((e, idx) => {
        const F = numFn(eqToExpr(e), [rx.v, ry.v, rz.v], 'implicitplot3d');
        const X = [], Y = [], Z = [], V = [];
        for (const x of xs) for (const y of ys) for (const z of zs) { X.push(x); Y.push(y); Z.push(z); V.push(F(x, y, z)); }
        const c = colors[idx] !== undefined ? colorName(colors[idx]) : colors.length === 1 ? colorName(colors[0]) : PALETTE3D[idx % PALETTE3D.length];
        const t = { type: 'isosurface', x: X, y: Y, z: Z, value: V, isomin: 0, isomax: 0, surface: { count: 1 }, caps: { x: { show: false }, y: { show: false }, z: { show: false } },
          showscale: false, colorscale: [[0, c], [1, c]], hoverinfo: 'skip' };
        if (opts.named.transparency) t.opacity = 1 - N(tr(opts.named.transparency));
        return t;
      });
      const L = base3D(opts, [rx.v, ry.v, rz.v]);
      L.scene.xaxis.range = [a0, a1]; L.scene.yaxis.range = [b0, b1]; L.scene.zaxis.range = [c0, c1];
      return plotResult(data, L, { is3d: true });
    },

    // curva de interseção de duas superfícies implícitas: intersectplot(S1, S2, x = .., y = .., z = ..)
    intersectplot(args) {
      const opts = parseOpts(args.slice(2));
      const [rx, ry, rz] = opts.ranges;
      if (!rx || !ry || !rz) throw err('intersectplot', 'expecting ranges for x, y and z, e.g. x = -4 .. 4, y = -4 .. 4, z = -4 .. 4');
      const vars = [rx.v, ry.v, rz.v];
      const F = numFn(eqToExpr(args[0]), vars, 'intersectplot'), Gf = numFn(eqToExpr(args[1]), vars, 'intersectplot');
      const lo = [rangeOf(rx)[0], rangeOf(ry)[0], rangeOf(rz)[0]], hi = [rangeOf(rx)[1], rangeOf(ry)[1], rangeOf(rz)[1]];
      const span = hi.map((h, k) => h - lo[k]);
      const inside = p => p.every((v, k) => v >= lo[k] - 1e-9 && v <= hi[k] + 1e-9);
      const pts = [];
      // fatias em cada eixo; em cada fatia resolve F = G = 0 nas outras duas variáveis por Newton a partir de uma grade
      const SL = 140, SEED = 16;
      for (let axis = 0; axis < 3; axis++) {
        const [i, j] = [0, 1, 2].filter(k => k !== axis);
        for (let s = 0; s <= SL; s++) {
          const fixed = lo[axis] + span[axis] * s / SL;
          const found = [];
          for (let u = 0; u <= SEED; u++) for (let w = 0; w <= SEED; w++) {
            const p = [0, 0, 0]; p[axis] = fixed; p[i] = lo[i] + span[i] * u / SEED; p[j] = lo[j] + span[j] * w / SEED;
            let ok = false;
            for (let it = 0; it < 25; it++) {
              const f = F(...p), g = Gf(...p);
              if (!isFinite(f) || !isFinite(g)) break;
              if (Math.abs(f) + Math.abs(g) < 1e-10) { ok = true; break; }
              const hi_ = 1e-6 * (1 + Math.abs(p[i])), hj = 1e-6 * (1 + Math.abs(p[j]));
              const pi = p.slice(); pi[i] += hi_; const pj = p.slice(); pj[j] += hj;
              const fi = (F(...pi) - f) / hi_, fj = (F(...pj) - f) / hj, gi = (Gf(...pi) - g) / hi_, gj = (Gf(...pj) - g) / hj;
              const det = fi * gj - fj * gi;
              if (!isFinite(det) || Math.abs(det) < 1e-14) break;
              p[i] -= (f * gj - fj * g) / det; p[j] -= (fi * g - f * gi) / det;
              if (Math.abs(p[i] - lo[i]) > 3 * span[i] || Math.abs(p[j] - lo[j]) > 3 * span[j]) break;
            }
            if (ok && inside(p) && !found.some(q => Math.abs(q[i] - p[i]) < 1e-6 * (1 + span[i]) && Math.abs(q[j] - p[j]) < 1e-6 * (1 + span[j]))) found.push(p.slice());
          }
          pts.push(...found);
        }
      }
      if (!pts.length) throw err('intersectplot', 'the surfaces do not intersect inside the given ranges');
      // liga os pontos em curvas pelo vizinho mais próximo (normalizado pelas faixas)
      const dist = (p, q) => Math.hypot(...p.map((v, k) => (v - q[k]) / span[k]));
      const uniq = [];
      for (const p of pts) if (!uniq.some(q => dist(p, q) < 2e-3)) uniq.push(p);
      const used = new Array(uniq.length).fill(false);
      const gap = 6 / SL;
      const X = [], Y = [], Z = [];
      const chain = start => {
        const line = [uniq[start]]; used[start] = true;
        for (const dir of [1, -1]) {
          let cur = dir === 1 ? line[line.length - 1] : line[0];
          for (;;) {
            let best = -1, bd = Infinity;
            for (let k = 0; k < uniq.length; k++) if (!used[k]) { const d = dist(cur, uniq[k]); if (d < bd) { bd = d; best = k; } }
            if (best < 0 || bd > gap) break;
            used[best] = true; cur = uniq[best];
            if (dir === 1) line.push(cur); else line.unshift(cur);
          }
        }
        // fecha a curva se as pontas estão próximas
        if (line.length > 3 && dist(line[0], line[line.length - 1]) < gap) line.push(line[0]);
        return line;
      };
      for (let k = 0; k < uniq.length; k++) if (!used[k]) {
        const line = chain(k);
        for (const p of line) { X.push(p[0]); Y.push(p[1]); Z.push(p[2]); }
        X.push(null); Y.push(null); Z.push(null);
      }
      const st = lineStyle(opts, 0);
      const L = base3D(opts, vars);
      L.scene.xaxis.range = [lo[0], hi[0]]; L.scene.yaxis.range = [lo[1], hi[1]]; L.scene.zaxis.range = [lo[2], hi[2]];
      return plotResult([{ type: 'scatter3d', mode: 'lines', x: X, y: Y, z: Z, line: { color: opts.named.color ? st.color : '#c40000', width: Math.max(4, st.width + 3) }, hoverinfo: 'skip' }], L, { is3d: true });
    },

    pointplot(args) {
      const opts = parseOpts(args.slice(1).filter(a => /=/.test(a)));
      let pts;
      const rest = args.slice(1).filter(a => !/=/.test(a));
      if (rest.length && isWrapped(args[0], '[', ']') && isWrapped(rest[0], '[', ']')) {
        const xs = listOrSet(args[0]).map(c => N(tr(c))), ys = listOrSet(rest[0]).map(c => N(tr(c)));
        pts = xs.map((x, i) => [x, ys[i]]);
      } else pts = listOrSet(resolveRaw(args[0])).map(p => listOrSet(p).map(c => N(tr(c))));
      const connect = opts.named.connect === 'true' || /line/.test(opts.named.style || '');
      const st = lineStyle(opts, 0);
      const t = { type: 'scatter', mode: connect ? 'lines+markers' : 'markers', x: pts.map(p => p[0]), y: pts.map(p => p[1]), marker: markerStyle(opts, 0), line: { color: st.color, width: st.width }, name: legendOf(opts, 0, 'pontos') };
      return plotResult([t], base2D(opts, 'x', 'y', [t]));
    },
    pointplot3d(args) {
      const opts = parseOpts(args.slice(1));
      const pts = listOrSet(resolveRaw(args[0])).map(p => listOrSet(p).map(c => N(tr(c))));
      const st = lineStyle(opts, 0);
      const connect = opts.named.connect === 'true' || /line/.test(opts.named.style || '');
      return plotResult([{ type: 'scatter3d', mode: connect ? 'lines+markers' : 'markers', x: pts.map(p => p[0]), y: pts.map(p => p[1]), z: pts.map(p => p[2]), marker: { size: 4, color: st.color }, line: { color: st.color } }], base3D(opts, ['x', 'y', 'z']), { is3d: true });
    },

    polarplot(args) {
      const a = args.slice();
      if (!a[1] || !/\.\./.test(a[1])) a.splice(1, 0, `${mainVar([a[0]], 'theta')} = 0 .. 2*Pi`);
      return PLOTS.plot(a.concat(['coords = polar']));
    },

    contourplot(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('contourplot', 'expecting ranges for both variables');
      const F = numFn(args[0], [rx.v, ry.v], 'contourplot');
      const [x0, x1] = rangeOf(rx), [y0, y1] = rangeOf(ry);
      const xs = linspace(x0, x1, 100), ys = linspace(y0, y1, 100);
      const z = ys.map(y => xs.map(x => { const v = F(x, y); return isFinite(v) ? v : null; }));
      const filled = opts.named.filled === 'true';
      const t = { type: 'contour', x: xs, y: ys, z, showscale: filled, colorscale: 'Viridis', contours: { coloring: filled ? 'fill' : 'lines' }, line: { width: 1.5 } };
      const cs = opts.named.contours;
      if (cs && isWrapped(cs, '[', ']')) {
        const lv = listOrSet(cs).map(c => N(tr(c))).sort((p, q) => p - q);
        const step = lv.length > 1 ? lv[1] - lv[0] : 1;
        Object.assign(t.contours, { start: lv[0], end: lv[lv.length - 1], size: step }); t.autocontour = false;
      } else t.ncontours = cs ? N(tr(cs)) + 1 : 9;
      return plotResult([t], base2D(opts, rx.v, ry.v, [t]));
    },

    densityplot(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('densityplot', 'expecting ranges for both variables');
      const F = numFn(args[0], [rx.v, ry.v], 'densityplot');
      const xs = linspace(...rangeOf(rx), 120), ys = linspace(...rangeOf(ry), 120);
      const z = ys.map(y => xs.map(x => { const v = F(x, y); return isFinite(v) ? v : null; }));
      const t = { type: 'heatmap', x: xs, y: ys, z, colorscale: opts.named.colorscheme ? 'Viridis' : 'Greys', reversescale: !opts.named.colorscheme, showscale: true };
      return plotResult([t], base2D(opts, rx.v, ry.v, [t]));
    },

    fieldplot(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('fieldplot', 'expecting ranges for both variables');
      const comps = listOrSet(args[0]);
      if (comps.length !== 2) throw err('fieldplot', 'expecting a vector field [u, v]');
      const U = numFn(comps[0], [rx.v, ry.v], 'fieldplot'), V = numFn(comps[1], [rx.v, ry.v], 'fieldplot');
      return arrowsPlot(U, V, rx, ry, opts);
    },
    gradplot(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('gradplot', 'expecting ranges for both variables');
      const f = tr(args[0]);
      const U = numFn(nd(`diff(${f},${rx.v})`).toString(), [rx.v, ry.v]), V = numFn(nd(`diff(${f},${ry.v})`).toString(), [rx.v, ry.v]);
      return arrowsPlot(U, V, rx, ry, opts);
    },

    spacecurve(args) {
      const opts = parseOpts(args.slice(1));
      const first = args[0].trim();
      const curves = listOrSet(first).every(c => isWrapped(c, '[', ']')) ? listOrSet(first).map(listOrSet) : [listOrSet(first)];
      const data = curves.map((c, idx) => {
        let r = opts.ranges[0];
        if (c.length === 4) { r = parseRange(c[3], 'spacecurve'); c = c.slice(0, 3); }
        if (!r) throw err('spacecurve', 'expecting a parameter range, e.g. t = 0 .. 2*Pi');
        const [a, b] = rangeOf(r);
        const ts = linspace(a, b, opts.named.numpoints ? N(tr(opts.named.numpoints)) : 400);
        const [fx, fy, fz] = c.map(e => numFn(e, [r.v], 'spacecurve'));
        const st = lineStyle(opts, idx);
        return { type: 'scatter3d', mode: 'lines', x: ts.map(fx), y: ts.map(fy), z: ts.map(fz), line: { color: st.color, width: st.width + 2 } };
      });
      return plotResult(data, base3D(opts, ['x', 'y', 'z']), { is3d: true });
    },

    textplot(args) {
      const opts = parseOpts(args.slice(1));
      const items = listOrSet(args[0]).every(c => isWrapped(c, '[', ']')) ? listOrSet(args[0]).map(listOrSet) : [listOrSet(args[0])];
      const st = lineStyle(opts, 0);
      const t = { type: 'scatter', mode: 'text', x: items.map(i => N(tr(i[0]))), y: items.map(i => N(tr(i[1]))), text: items.map(i => isString(i[2]) ? strVal(i[2]) : nd(tr(i[2])).toString()), textfont: { color: st.color, size: 14 }, showlegend: false, hoverinfo: 'skip' };
      return plotResult([t], base2D(opts, '', '', [t]));
    },

    logplot(args) { const r = PLOTS.plot(args); r.plot.layout.yaxis.type = 'log'; delete r.plot.layout.yaxis.range; return r; },
    semilogplot(args) { const r = PLOTS.plot(args); r.plot.layout.xaxis.type = 'log'; return r; },
    loglogplot(args) { const r = PLOTS.plot(args); r.plot.layout.xaxis.type = 'log'; r.plot.layout.yaxis.type = 'log'; delete r.plot.layout.yaxis.range; return r; },

    inequal(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('inequal', 'expecting ranges for both variables');
      const conds = isWrapped(args[0], '{', '}') || isWrapped(args[0], '[', ']') ? listOrSet(args[0]) : [args[0]];
      const tests = conds.map(c => relFn(c, [rx.v, ry.v]));
      const xs = linspace(...rangeOf(rx), 200), ys = linspace(...rangeOf(ry), 200);
      const z = ys.map(y => xs.map(x => tests.every(t => t(x, y)) ? 1 : null));
      const t = { type: 'heatmap', x: xs, y: ys, z, colorscale: [[0, '#7fa7e6'], [1, '#7fa7e6']], showscale: false, opacity: 0.6, hoverinfo: 'skip' };
      return plotResult([t], base2D(opts, rx.v, ry.v, [t]));
    },

    animate(args) {
      // animate(plotcommand, [argumentos], a = a0 .. a1, frames = n)
      const cmd = args[0].trim();
      const fnc = PLOTS[cmd] || CMD[cmd];
      if (!fnc) throw err('animate', `${cmd} is not a plotting command`);
      const inner = listOrSet(args[1]);
      const opts = parseOpts(args.slice(2));
      const pr = opts.ranges[0];
      if (!pr || !pr.v) throw err('animate', 'expecting a range for the animation parameter, e.g. a = 0 .. 2');
      const [a0, a1] = rangeOf(pr, 'animate');
      const nF = opts.named.frames ? Math.max(2, N(tr(opts.named.frames))) : 25;
      const vals = linspace(a0, a1, nF - 1);
      const re = new RegExp(`\\b${pr.v}\\b`, 'g');
      const frames = vals.map(v => fnc(inner.map(s => s.replace(re, `(${v})`))).plot);
      const labels = vals.map(v => `${pr.v} = ${+v.toPrecision(4)}`);
      return animateFrom(frames.map(f => f.data), frames[0].layout, labels, !!frames[0].is3d, frames.map(f => f.layout));
    },
  };
  Object.assign(PLOTS, { odeplot() { throw err('odeplot', 'odeplot needs dsolve(..., numeric), which is not available yet'); } });

  function arrowsPlot(U, V, rx, ry, opts) {
    const n = opts.named.grid ? N(tr(listOpt(opts.named.grid)[0])) : 16;
    const [x0, x1] = rangeOf(rx), [y0, y1] = rangeOf(ry);
    const xs = linspace(x0, x1, n - 1), ys = linspace(y0, y1, n - 1);
    const cell = Math.min((x1 - x0), (y1 - y0)) / n;
    let maxM = 0; const vecs = [];
    for (const x of xs) for (const y of ys) { const u = U(x, y), v = V(x, y); if (isFinite(u) && isFinite(v)) { vecs.push([x, y, u, v]); maxM = Math.max(maxM, Math.hypot(u, v)); } }
    const X = [], Y = [];
    const fixed = opts.named.fieldstrength && /fixed/.test(opts.named.fieldstrength);
    for (const [x, y, u, v] of vecs) {
      const m = Math.hypot(u, v); if (!m) continue;
      const len = 0.85 * cell * (fixed ? 1 : m / maxM);
      const dx = u / m * len, dy = v / m * len, ex = x + dx, ey = y + dy;
      const h = len * 0.3, ang = Math.atan2(dy, dx);
      X.push(x, ex, null, ex, ex - h * Math.cos(ang - 0.45), null, ex, ex - h * Math.cos(ang + 0.45), null);
      Y.push(y, ey, null, ey, ey - h * Math.sin(ang - 0.45), null, ey, ey - h * Math.sin(ang + 0.45), null);
    }
    const st = lineStyle(opts, 0);
    const t = { type: 'scatter', mode: 'lines', x: X, y: Y, line: { color: st.color, width: 1.4 }, hoverinfo: 'skip', showlegend: false };
    const L = base2D(opts, rx.v, ry.v, [t]); L.xaxis.range = [x0 - cell, x1 + cell]; L.yaxis.range = [y0 - cell, y1 + cell];
    return plotResult([t], L);
  }

  // animação com botão de play e controle deslizante (como o player de animação do Maple)
  function animateFrom(datas, layout0, labels, is3d, layouts) {
    const layout = JSON.parse(JSON.stringify(layout0));
    if (!is3d) { // eixos fixos em todos os quadros
      const all = datas.flat();
      const xs = all.flatMap(t => (t.x || []).flat()).filter(v => typeof v === 'number' && isFinite(v));
      const ys = all.flatMap(t => (t.y || []).flat()).filter(v => typeof v === 'number' && isFinite(v));
      const yr = layouts ? layouts.map(l => l.yaxis && l.yaxis.range).filter(Boolean) : [];
      if (xs.length && !layout.xaxis.range) layout.xaxis.range = [Math.min(...xs), Math.max(...xs)];
      if (yr.length) layout.yaxis.range = [Math.min(...yr.map(r => r[0])), Math.max(...yr.map(r => r[1]))];
      else if (ys.length) { const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.05 || 1; layout.yaxis.range = [lo - pad, hi + pad]; }
    }
    const frames = datas.map((d, i) => ({ name: labels[i], data: d }));
    layout.updatemenus = [{ type: 'buttons', showactive: false, x: 0, y: 0, xanchor: 'left', yanchor: 'top', pad: { t: 50, r: 10 }, buttons: [
      { label: '▶', method: 'animate', args: [null, { frame: { duration: 120, redraw: true }, fromcurrent: true, transition: { duration: 0 } }] },
      { label: '❚❚', method: 'animate', args: [[null], { mode: 'immediate', frame: { duration: 0, redraw: false } }] }] }];
    layout.sliders = [{ active: 0, x: 0.12, len: 0.88, y: 0, yanchor: 'top', pad: { t: 40 }, currentvalue: { prefix: '', font: { size: 12 } },
      steps: labels.map(l => ({ label: l, method: 'animate', args: [[l], { mode: 'immediate', frame: { duration: 0, redraw: true }, transition: { duration: 0 } }] })) }];
    layout.margin = { b: 90 };
    return { plot: { data: datas[0], layout, frames, is3d, animated: true } };
  }

  // relação (x < y, x >= 1, …) como teste numérico
  function relFn(c, vars) {
    const m = splitRel(c);
    if (!m) throw err(null, `expecting an inequality, got ${c}`);
    const L = numFn(m.lhs, vars, 'inequal'), Rr = numFn(m.rhs, vars, 'inequal');
    return (...a) => cmpNum(L(...a), m.op, Rr(...a));
  }

  /* ======================= Relações, lógica e comandos de fluxo ======================= */

  // separa "a <= b" em {lhs, op, rhs} no nível superior
  function splitRel(s) {
    let depth = 0, q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') q = !q;
      if (q) continue;
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (depth === 0) {
        const two = s.slice(i, i + 2);
        if (two === '<=' || two === '>=' || two === '<>') return { lhs: s.slice(0, i), op: two, rhs: s.slice(i + 2) };
        if (ch === '<' || ch === '>') return { lhs: s.slice(0, i), op: ch, rhs: s.slice(i + 1) };
        if (ch === '=' && s[i - 1] !== ':' ) return { lhs: s.slice(0, i), op: '=', rhs: s.slice(i + 1) };
      }
    }
    return null;
  }
  function cmpNum(a, op, b) {
    if (!isFinite(a) || !isFinite(b)) return false;
    const eps = 1e-12 * (1 + Math.abs(a) + Math.abs(b));
    switch (op) {
      case '<': return a < b - eps; case '>': return a > b + eps;
      case '<=': return a <= b + eps; case '>=': return a >= b - eps;
      case '=': return Math.abs(a - b) <= eps; case '<>': return Math.abs(a - b) > eps;
    }
    return false;
  }
  // divide por palavra-chave lógica no nível superior (and / or)
  function splitWord(s, word) {
    const out = []; let depth = 0, q = false, last = 0;
    const re = new RegExp(`^\\s${word}\\s`);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') q = !q;
      if (q) continue;
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (depth === 0 && re.test(s.slice(i))) { out.push(s.slice(last, i)); last = i + word.length + 2; i = last - 1; }
    }
    out.push(s.slice(last));
    return out;
  }
  // avalia uma condição do Maple: relações, and, or, not, true/false, isprime(…) etc.
  // devolve true, false ou null (não dá para decidir, como o FAIL do Maple)
  function truth(c) {
    c = c.trim();
    while (isWrapped(c, '(', ')')) c = unwrap(c).trim();
    const ors = splitWord(c, 'or');
    if (ors.length > 1) { let unk = false; for (const p of ors) { const t = truth(p); if (t === true) return true; if (t === null) unk = true; } return unk ? null : false; }
    const ands = splitWord(c, 'and');
    if (ands.length > 1) { let unk = false; for (const p of ands) { const t = truth(p); if (t === false) return false; if (t === null) unk = true; } return unk ? null : true; }
    if (/^not\s/.test(c)) { const t = truth(c.slice(4)); return t === null ? null : !t; }
    if (c === 'true') return true;
    if (c === 'false') return false;
    const rel = splitRel(c);
    if (!rel) {
      const v = valueOfExpr(c);
      if (v === 'true') return true;
      if (v === 'false') return false;
      if (v && v !== c && splitRel(v)) return truth(v);
      throw err(null, `cannot determine if this expression is true or false: ${c}`);
    }
    const l = nd(tr(rel.lhs)).toString(), r = nd(tr(rel.rhs)).toString();
    if (rel.op === '=' || rel.op === '<>') {
      let same;
      try { same = nd(`simplify(expand((${l})-(${r})))`).toString() === '0'; } catch (e) { same = l === r; }
      if (!same) {
        const d = nd(`(${l})-(${r})`);
        if (d.variables().length) return rel.op === '=' ? false : true; // como evalb: comparação sintática
        same = cmpNum(N(l), '=', N(r));
      }
      return rel.op === '=' ? same : !same;
    }
    const lv = N(l), rv = N(r);
    if (!isFinite(lv) || !isFinite(rv)) return null;
    return cmpNum(lv, rel.op, rv);
  }
  function valueOfExpr(c) {
    const r = evalExpr(c);
    return r.value;
  }
  const boolR = b => ({ value: b === null ? 'FAIL' : String(b), tex: `\\mathit{${b === null ? 'FAIL' : b}}` });

  // valor "cru" guardado num nome (equações, listas de equações, strings)
  function resolveRaw(arg) {
    const a = arg.trim();
    if (state.eqs.has(a)) return state.eqs.get(a);
    if (state.vars.has(a)) { const v = nd(a).toString(); if (/^\[/.test(v)) return v; }
    return a;
  }
  // aplica fn a cada lado de uma equação (ou à expressão)
  function mapEq(str, fn) {
    let s = str.trim();
    while (isWrapped(s, '(', ')')) s = unwrap(s).trim();
    const e = parseEq(s);
    if (e) { const l = fn(e.lhs), r = fn(e.rhs); return { value: `${l}=${r}`, tex: eqTeX(l, r) }; }
    return R(fn(s));
  }

  function printfFormat(fmt, vals) {
    let k = 0;
    return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([dfeEgGasqcx%])/g, (m, flags, width, prec, conv) => {
      if (conv === '%') return '%';
      const v = vals[k++];
      let s;
      if (conv === 'd') s = String(Math.round(N(v)));
      else if (conv === 'f') s = N(v).toFixed(prec !== undefined ? +prec : 6);
      else if (conv === 'e' || conv === 'E') { s = N(v).toExponential(prec !== undefined ? +prec : 6); if (conv === 'E') s = s.toUpperCase(); }
      else if (conv === 'g' || conv === 'G') s = String(+N(v).toPrecision(prec !== undefined ? +prec : 6));
      else if (conv === 's') s = isString(v) ? strVal(v) : nd(tr(v)).toString();
      else if (conv === 'c') s = isString(v) ? strVal(v) : String(v);
      else if (conv === 'x') s = Math.round(N(v)).toString(16);
      else s = isString(v) ? strVal(v) : nd(tr(v)).toString(); // %a, %q
      if (width && s.length < +width) s = flags.includes('-') ? s.padEnd(+width) : s.padStart(+width, flags.includes('0') ? '0' : ' ');
      return s;
    }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  const FLOW = {
    evalb(args) { return boolR(truth(args[0])); },
    is(args) { return boolR(truth(args[0])); },
    assign(args) {
      const items = args.length === 2 && !/=/.test(args[0]) ? [`${args[0]}=${args[1]}`] : args.flatMap(a => listOrSet(resolveRaw(a)));
      for (const it of items) {
        const e = parseEq(it);
        if (!e || !/^[A-Za-z_]\w*$/.test(e.lhs.trim())) throw err('assign', `invalid arguments: ${it}`);
        const name = e.lhs.trim(), v = nd(tr(e.rhs)).toString();
        setUserVar(name, v);
      }
      return { none: true };
    },
    map(args) {
      const f = args[0].trim(), extra = args.slice(2).map(tr);
      const target = resolveRaw(args[1]);
      const apply = x => {
        const arrow = arrowFn(f);
        if (arrow) {
          const sub = {}; arrow.params.forEach((p, i) => { sub[p] = i === 0 ? `(${x})` : `(${extra[i - 1]})`; });
          return nd(tr(arrow.body), sub).toString();
        }
        return nd(tr(`${f}(${[x].concat(extra).join(',')})`)).toString();
      };
      if (isWrapped(target, '{', '}') || isWrapped(target, '[', ']')) {
        const items = listOrSet(target).map(x => apply(tr(x)));
        return seqR(items, target.trim()[0] === '{' ? '{' : '[');
      }
      const v = nd(tr(target)).toString();
      if (/^\[/.test(v)) return seqR(splitTop(v.slice(1, -1)).map(apply), '[');
      if (/^matrix\(/.test(v)) return R(`matrix(${toRows(v).map(r => '[' + r.map(apply).join(',') + ']').join(',')})`);
      return R(apply(v));
    },
    select(args) { return filterList(args, true); },
    remove(args) { return filterList(args, false); },
    piecewise(args) {
      const pairs = [];
      for (let k = 0; k < args.length; k += 2) pairs.push(k + 1 < args.length ? [args[k], args[k + 1]] : [null, args[k]]);
      // valor numérico quando as condições são decidíveis
      for (const [c, v] of pairs) {
        if (c === null) return R(nd(tr(v)).toString());
        let t; try { t = truth(c); } catch (e) { t = null; }
        if (t === true) return R(nd(tr(v)).toString());
        if (t === null) break;
      }
      const rows = pairs.map(([c, v]) => `${tex(tr(v))} & ${c === null ? '\\text{otherwise}' : relTeX(c)}`).join(' \\\\ ');
      return { value: `piecewise(${args.join(',')})`, tex: `\\begin{cases} ${rows} \\end{cases}`, piecewise: pairs };
    },
    printf(args) {
      if (!args.length || !isString(args[0])) throw err('printf', 'format must be a string');
      return { print: printfFormat(strVal(args[0]), args.slice(1)), none: true };
    },
    print(args) {
      const t = args.map(a => isString(a) ? `\\text{${strVal(a)}}` : sideR(a).tex).join(',\\; ');
      return { tex: t, forcePrint: true, none: true };
    },
    type(args) {
      const v = nd(tr(args[0])).toString(), t = args[1].trim();
      const num = !nd(v).variables().length;
      const checks = { integer: () => /^-?\d+$/.test(v), posint: () => /^\d+$/.test(v) && v !== '0', nonnegint: () => /^\d+$/.test(v),
        numeric: () => num, rational: () => /^-?\d+(\/\d+)?$/.test(v), even: () => /^-?\d+$/.test(v) && BigInt(v) % 2n === 0n,
        odd: () => /^-?\d+$/.test(v) && BigInt(v) % 2n !== 0n, list: () => /^\[/.test(v), positive: () => num && N(v) > 0, negative: () => num && N(v) < 0 };
      if (!checks[t]) throw err('type', `type ${t} is not supported`);
      return boolR(checks[t]());
    },
    irem(args) { const a = BigInt(nd(tr(args[0])).toString()), b = BigInt(nd(tr(args[1])).toString()); return R((a % b).toString()); },
    iquo(args) { const a = BigInt(nd(tr(args[0])).toString()), b = BigInt(nd(tr(args[1])).toString()); return R((a / b).toString()); },
    round(args) { return R(String(Math.round(N(tr(args[0]))))); },
    floor(args) { return R(String(Math.floor(N(tr(args[0]))))); },
    ceil(args) { return R(String(Math.ceil(N(tr(args[0]))))); },
    trunc(args) { return R(String(Math.trunc(N(tr(args[0]))))); },
    frac(args) { const x = N(tr(args[0])); return R(nd(`(${tr(args[0])})-(${Math.trunc(x)})`).toString()); },
    op(args) {
      const i = N(tr(args[0])), v = resolveRaw(args[1]);
      const items = isWrapped(v, '[', ']') || isWrapped(v, '{', '}') ? listOrSet(v) : splitTop(nd(tr(v)).toString().replace(/^\[|\]$/g, ''));
      return R(nd(tr(items[i - 1])).toString());
    },
  };
  function filterList(args, keep) {
    const f = args[0].trim(), target = resolveRaw(args[1]);
    const items = isWrapped(target, '[', ']') || isWrapped(target, '{', '}') ? listOrSet(target) : splitTop(nd(tr(target)).toString().replace(/^\[|\]$/g, ''));
    const arrow = arrowFn(f);
    const test = x => {
      if (arrow) { const body = arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\b`, 'g'), `(${x})`); return truth(body) === true; }
      return truth(`${f}(${x})`) === true;
    };
    const out = items.filter(x => test(nd(tr(x)).toString()) === keep).map(x => nd(tr(x)).toString());
    return seqR(out, target.trim()[0] === '{' ? '{' : '[');
  }
  function relTeX(c) {
    const r = splitRel(c);
    if (!r) return tex(tr(c));
    const OP = { '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '=': '=', '<>': '\\ne' };
    return `${tex(tr(r.lhs))} ${OP[r.op]} ${tex(tr(r.rhs))}`;
  }

  /* ======================= Linguagem: for, while, if, proc ======================= */

  class Signal { constructor(kind, value) { this.kind = kind; this.value = value; } }

  // palavras-chave de bloco fora de strings
  function kwTokens(text) {
    const toks = []; let q = false;
    const re = /[A-Za-z_]\w*/y;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { q = !q; continue; }
      if (q || !/[A-Za-z_]/.test(ch) || /[\w]/.test(text[i - 1] || '')) continue;
      re.lastIndex = i; const m = re.exec(text); if (!m) continue;
      const w = m[0];
      if (/^(do|od|if|fi|proc|end|then|elif|else|for|while|from|to|by|in|local|global|return|break|next|options|description)$/.test(w)) toks.push({ w, i, j: i + w.length });
      i += w.length - 1;
    }
    return toks;
  }
  // profundidade de bloco antes (before) e depois (after) de cada palavra-chave:
  // do/if/proc abrem; end [do|if|proc], od e fi fecham
  function annotateDepth(toks) {
    let d = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      t.before = d;
      if (t.w === 'do' || t.w === 'if' || t.w === 'proc') d++;
      else if (t.w === 'od' || t.w === 'fi') d--;
      else if (t.w === 'end') {
        d--;
        const nx = toks[k + 1];
        if (nx && /^(do|if|proc)$/.test(nx.w) && /^\s*$/.test(TB_TEXT.slice(t.j, nx.i))) { nx.before = d + 1; nx.after = d; nx.closer = true; k++; }
      }
      t.after = d;
    }
    return toks;
  }
  let TB_TEXT = '';

  // separa instruções por ; ou : no nível superior (fora de parênteses, strings e blocos do/if/proc)
  function splitStatements(text) {
    text = stripComments(text);
    TB_TEXT = text;
    const toks = annotateDepth(kwTokens(text));
    const blockDepthAt = i => { let d = 0; for (const t of toks) { if (t.i >= i) break; d = t.after; } return d; };
    const out = []; let depth = 0, cur = '', q = false, start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') q = !q;
      if (!q) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (depth === 0 && (ch === ';' || (ch === ':' && text[i + 1] !== '=' && text[i + 1] !== '-' && text[i + 1] !== ':' && text[i - 1] !== ':')) && blockDepthAt(i) === 0) {
          if (cur.trim()) out.push({ src: cur.trim(), show: ch === ';' });
          cur = ''; start = i + 1; continue;
        }
      }
      cur += ch;
    }
    if (cur.trim()) out.push({ src: cur.trim(), show: true, noTerm: true });
    return out;
  }
  function stripComments(text) {
    let out = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') q = !q;
      if (!q && ch === '#') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
      out += ch;
    }
    return out;
  }

  // executa uma instrução (com laços e condicionais) e recolhe a saída em ctx.blocks
  function execStatement(src, ctx) {
    src = src.trim();
    if (!src) return null;
    const head = /^(\w+)/.exec(src);
    const w = head && head[1];
    if (w === 'for' || w === 'while' || (w === 'do' && /\b(end\s+do|od)$/.test(src))) return execLoop(src, ctx);
    if (w === 'if') { const r = execIf(src, ctx); return r.none ? r : Object.assign({}, r, { none: false, fromBlock: true }); }
    if (w === 'return') throw new Signal('return', src.slice(6).trim() ? evalStatement(src.slice(6).trim()) : { none: true });
    if (w === 'break' && src === 'break') throw new Signal('break');
    if (w === 'next' && src === 'next') throw new Signal('next');
    if ((w === 'local' || w === 'global') && ctx.inProc) return null;
    const r = evalStatement(src);
    if (state.procOut.length) { ctx.blocks.push(...state.procOut); state.procOut = []; }
    if (r.print !== undefined) ctx.blocks.push({ note: r.print });
    if (r.forcePrint) ctx.blocks.push({ tex: r.tex });
    if (ctx.show && !r.none && !r.forcePrint) {
      if (r.plot) ctx.blocks.push({ plot: r.plot });
      else if (r.tex !== undefined) ctx.blocks.push({ tex: r.tex });
    }
    if (r.value !== undefined && !r.noHistory) pushHistory(r.value);
    return r;
  }
  function execBody(body, ctx) {
    let last = null;
    for (const st of splitStatements(body)) { const r = execStatement(st.src, ctx); if (r) last = r; }
    return last;
  }
  function blockParts(src, openWord, closeWords) {
    TB_TEXT = src;
    const toks = annotateDepth(kwTokens(src));
    return toks;
  }
  function execLoop(src, ctx) {
    const toks = blockParts(src);
    const doTok = toks.find(t => t.w === 'do' && t.before === 0 && !t.closer);
    const endTok = [...toks].reverse().find(t => (t.w === 'end' || t.w === 'od') && t.after === 0);
    if (!doTok || !endTok) throw err(null, 'incomplete loop: expecting `for ... do ... end do`');
    const header = src.slice(0, doTok.i).trim(), body = src.slice(doTok.j, endTok.i);
    const h = {};
    const parts = header.split(/\b(for|from|to|by|in|while)\b/).map(s => s.trim());
    for (let k = 1; k < parts.length; k += 2) h[parts[k]] = parts[k + 1];
    const v = h.for;
    let count = 0;
    const MAX = 100000;
    const runBody = () => {
      try { execBody(body, ctx); } catch (s) { if (s instanceof Signal && s.kind === 'break') return 'break'; if (s instanceof Signal && s.kind === 'next') return 'next'; throw s; }
      return null;
    };
    if (h.in !== undefined) {
      const L = resolveRaw(h.in);
      const items = isWrapped(L, '[', ']') || isWrapped(L, '{', '}') ? listOrSet(L) : splitTop(nd(tr(L)).toString().replace(/^\[|\]$/g, ''));
      for (const it of items) {
        setUserVar(v, nd(tr(it)).toString());
        if (h.while !== undefined && truth(h.while) !== true) break;
        if (runBody() === 'break') break;
      }
      return { none: true };
    }
    const from = h.from !== undefined ? nd(tr(h.from)).toString() : '1';
    const by = h.by !== undefined ? N(tr(h.by)) : 1;
    const to = h.to !== undefined ? N(tr(h.to)) : null;
    let x = from;
    while (true) {
      if (++count > MAX) throw err(null, 'loop stopped after 100000 iterations');
      if (v) setUserVar(v, x);
      if (to !== null && (by > 0 ? N(x) > to + 1e-12 : N(x) < to - 1e-12)) break;
      if (h.while !== undefined && truth(h.while) !== true) break;
      if (runBody() === 'break') break;
      if (v) x = nd(`(${v})+(${by})`).toString();
      else if (h.while === undefined && to === null) throw err(null, 'infinite loop: add `to` or `while`');
    }
    return { none: true };
  }
  function execIf(src, ctx) {
    const toks = blockParts(src);
    const seq = toks.filter(t => !t.closer && ((t.w === 'if' && t.before === 0) || (/^(then|elif|else)$/.test(t.w) && t.before === 1) || ((t.w === 'end' || t.w === 'fi') && t.after === 0)));
    const branches = []; let cond = null, from = null, kind = null;
    for (const t of seq) {
      if (t.w === 'if' || t.w === 'elif') { if (kind) branches.push({ cond, body: src.slice(from, t.i) }); kind = t.w; from = t.j; cond = null; }
      else if (t.w === 'then') { cond = src.slice(from, t.i); from = t.j; }
      else if (t.w === 'else') { branches.push({ cond, body: src.slice(from, t.i) }); kind = 'else'; cond = 'true'; from = t.j; }
      else if (t.w === 'end' || t.w === 'fi') { branches.push({ cond, body: src.slice(from, t.i) }); break; }
    }
    for (const b of branches) {
      const t = truth(b.cond);
      if (t === null) throw err(null, `cannot determine if this expression is true or false: ${b.cond.trim()}`);
      if (t) { const last = execBody(b.body, ctx); return last ? Object.assign({}, last, { shown: true }) : { none: true }; }
    }
    return { none: true };
  }

  // proc(params) local …; corpo end proc
  function parseProc(src) {
    const m = /^proc\s*\(/.exec(src.trim());
    if (!m) return null;
    const s = src.trim();
    const open = s.indexOf('(');
    const close = matchClose(s, open);
    const params = s.slice(open + 1, close).split(',').map(p => p.replace(/::.*$/, '').trim()).filter(Boolean);
    TB_TEXT = s;
    const toks = annotateDepth(kwTokens(s));
    const endTok = [...toks].reverse().find(t => t.w === 'end' && t.after === 0);
    if (!endTok) throw err(null, 'incomplete procedure: expecting `end proc`');
    let body = s.slice(close + 1, endTok.i);
    const locals = [];
    body = body.replace(/^\s*(local|global|options|description)\s+([^;]*);/gm, (all, kw, list) => { if (kw === 'local') locals.push(...list.split(',').map(x => x.replace(/::.*$/, '').trim())); return ''; });
    return { params, locals, body, src: s };
  }
  function callProc(name, P, argVals) {
    const saved = new Map();
    const names = [...P.params, ...P.locals];
    for (const n of names) saved.set(n, state.vars.has(n) ? nd(n).toString() : null);
    state.depth = (state.depth || 0) + 1;
    if (state.depth > 200) { state.depth = 0; throw err(name, 'too many levels of recursion'); }
    try {
      P.params.forEach((p, i) => { if (argVals[i] !== undefined) setUserVar(p, argVals[i]); });
      P.locals.forEach(l => clearUserVar(l));
      const ctx = { blocks: [], show: false, inProc: true };
      let last = null;
      try { last = execBody(P.body, ctx); }
      catch (s) { if (s instanceof Signal && s.kind === 'return') last = s.value; else throw s; }
      state.procOut.push(...ctx.blocks);
      if (!last || last.none || last.value === undefined) return { value: 'NULL', tex: '' };
      return { value: last.value, tex: last.tex };
    } finally {
      state.depth--;
      for (const [n, v] of saved) { if (v === null) clearUserVar(n); else setUserVar(n, v); }
    }
  }
  function setUserVar(name, value) {
    if (/=/.test(value) || isString(value)) { state.eqs.set(name, value); try { nd.setVar(vn(name), 'delete'); } catch (e) {} state.vars.delete(name); return; }
    state.eqs.delete(name);
    nd.setVar(vn(name), value);
    state.vars.add(name);
  }
  function clearUserVar(name) { try { nd.setVar(vn(name), 'delete'); } catch (e) {} state.vars.delete(name); state.eqs.delete(name); }
  // nome interno: o "i" do usuário não pode colidir com a unidade imaginária do motor (no Maple ela é I)
  const vn = name => (name === 'i' ? 'iI' : name);
  function pushHistory(v) { state.history.push(v); if (state.history.length > 3) state.history.shift(); }

  /* ======================= Cálculo 2: sistemas, integração numérica, séries, várias variáveis ======================= */

  // ---------- sistemas de equações (inclusive não lineares) por fatoração e substituição ----------
  function factorList(expr) {
    let f;
    try { f = nd(`factor(${expr})`).toString(); } catch (e) { f = expr; }
    const parts = splitSum(f.replace(/^-/, '')).length > 1 ? [f] : splitProduct(f.replace(/^-(?=\()/, ''));
    const base = p => {
      const m = /^\(([\s\S]*)\)\^\d+$/.exec(p);
      if (m && matchClose(p, 0) === p.lastIndexOf(')')) return m[1];
      const k = /^([A-Za-z_]\w*)\^\d+$/.exec(p);
      return k ? k[1] : p;
    };
    return parts.map(base).filter(p => { try { return nd(p).variables().length > 0; } catch (e) { return true; } });
  }
  function splitProduct(s) { // fatores de um produto no nível superior
    const out = []; let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === '*' && depth === 0 && s[i + 1] !== '*' && s[i - 1] !== '*') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(t => t.trim()).filter(Boolean);
  }
  const degIn = (e, v) => { try { const d = nd(`deg(${e},${v})`).toString(); return /^\d+$/.test(d) ? +d : 99; } catch (x) { return 99; } };
  function numerOf(e) { try { return nd(e).symbol.getNum().text(); } catch (x) { return e; } }
  function cleanEq(e) { // numerador expandido de uma equação já em forma "expr = 0"
    let s;
    try { s = nd(`expand(${e})`).toString(); } catch (x) { s = e; }
    try { if (/\^\(-|\//.test(s)) s = nd(`expand(${numerOf(nd(`simplify(${s})`).toString())})`).toString(); } catch (x) {}
    return s;
  }
  // penaliza resolver por uma variável cujo coeficiente depende das outras (dividir por ele perde soluções)
  function coefPenalty(f, v, vars) {
    try { const c = nd(`diff(${f},${v})`).toString(); return nd(c).variables().some(x => vars.includes(x)) ? 6 : 0; } catch (e) { return 6; }
  }
  function isLinearSystem(exprs, vars) {
    try {
      return exprs.every(e => vars.every(a => vars.every(b => nd(`diff(diff(${e},${a}),${b})`).toString() === '0')));
    } catch (e) { return false; }
  }
  function solveSys(eqs, vars, depth = 0) {
    if (depth > 8) return [];
    eqs = eqs.map(cleanEq).filter(e => e !== '0');
    for (const e of eqs) { try { if (!nd(e).variables().some(v => vars.includes(v))) { const v = N(e); if (isFinite(v) && Math.abs(v) > 1e-12) return []; if (!nd(e).variables().length) continue; } } catch (x) {} }
    eqs = eqs.filter(e => nd(e).variables().some(v => vars.includes(v)));
    if (!eqs.length) return [{}];
    // escolhe a equação e a variável mais fáceis (menor grau)
    let best = null;
    for (const e of eqs) {
      for (const f of factorList(e)) {
        for (const v of vars) {
          const d = degIn(f, v);
          if (d >= 1 && d <= 4) { const score = d * 10 + nd(f).variables().length + factorList(e).length + coefPenalty(f, v, vars); if (!best || score < best.score) best = { e, score }; }
        }
      }
    }
    if (!best) return null; // não conseguimos
    const results = [];
    const rest = eqs.filter(x => x !== best.e);
    for (const f of factorList(best.e)) {
      let choice = null;
      for (const v of vars) { const d = degIn(f, v); const sc = d * 10 + coefPenalty(f, v, vars); if (d >= 1 && d <= 4 && (!choice || sc < choice.sc)) choice = { v, d, sc }; }
      if (!choice) continue;
      let sols;
      try { sols = splitTop(nd(`solve(${f},${choice.v})`).toString().replace(/^\[|\]$/g, '')).filter(Boolean); } catch (x) { sols = []; }
      for (const s of sols) {
        const sub = rest.map(r => nd(r, { [choice.v]: `(${s})` }).toString());
        const others = vars.filter(v => v !== choice.v);
        const subRes = solveSys(sub, others, depth + 1);
        if (!subRes) continue;
        for (const r of subRes) {
          const val = Object.keys(r).length ? nd(`simplify(${nd(s, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, `(${v})`]))).toString()})`).toString() : nd(`simplify(${s})`).toString();
          results.push(Object.assign({}, r, { [choice.v]: val }));
        }
      }
    }
    // variáveis livres ficam como elas mesmas (como no Maple: x = x)
    return results.map(r => { const o = {}; vars.forEach(v => { o[v] = r[v] !== undefined ? r[v] : v; }); return o; });
  }
  function dedupeSols(sols, vars, eqs) {
    const seen = new Set(), out = [];
    for (const s of sols) {
      // confere numericamente quando possível
      let ok = true;
      for (const e of eqs) {
        try {
          const v = nd(e, Object.fromEntries(vars.map(x => [x, `(${s[x]})`]))).evaluate().text('decimals');
          const num = Number(v);
          if (isFinite(num) && Math.abs(num) > 1e-6) { ok = false; break; }
        } catch (x) {}
      }
      if (!ok) continue;
      const key = vars.map(v => { try { const n = N(s[v]); return isFinite(n) ? n.toFixed(9) : nd(s[v]).toString(); } catch (x) { return s[v]; } }).join('|');
      if (seen.has(key)) continue;
      seen.add(key); out.push(s);
    }
    const isReal = s => vars.every(v => !/\bi\b/.test(nd(s[v]).toString()));
    return out.filter(isReal).concat(out.filter(s => !isReal(s)));
  }

  // ---------- integração numérica (Simpson adaptativo, com intervalos infinitos) ----------
  function quad(f, a, b, tol = 1e-10) {
    if (a === b) return 0;
    if (a > b) return -quad(f, b, a, tol);
    if (!isFinite(a) || !isFinite(b)) {
      if (!isFinite(a) && !isFinite(b)) return quad(t => { const x = t / (1 - t * t); return f(x) * (1 + t * t) / Math.pow(1 - t * t, 2); }, -1 + 1e-9, 1 - 1e-9, tol);
      if (!isFinite(b)) return quad(t => { const x = a + t / (1 - t); return f(x) / Math.pow(1 - t, 2); }, 0, 1 - 1e-9, tol);
      return quad(t => { const x = b - t / (1 - t); return f(x) / Math.pow(1 - t, 2); }, 0, 1 - 1e-9, tol);
    }
    // Gauss–Legendre de 10 pontos adaptativo (bom para funções suaves, tolera singularidades integráveis nas pontas)
    const X = [0.1488743389816312, 0.4333953941292472, 0.6794095682990244, 0.8650633666889845, 0.9739065285171717];
    const W = [0.2955242247147529, 0.2692667193099963, 0.2190863625159820, 0.1494513491505806, 0.0666713443086881];
    const gl = (p, q) => { const c = (p + q) / 2, h = (q - p) / 2; let s = 0; for (let k = 0; k < 5; k++) { const y1 = f(c - h * X[k]), y2 = f(c + h * X[k]); s += W[k] * ((isFinite(y1) ? y1 : 0) + (isFinite(y2) ? y2 : 0)); } return s * h; };
    let evals = 0;
    const rec = (p, q, whole, depth) => {
      const m = (p + q) / 2, L = gl(p, m), Rr = gl(m, q);
      evals += 40;
      if (depth > 18 || evals > 400000 || Math.abs(L + Rr - whole) <= tol * Math.max(1, Math.abs(L + Rr))) return L + Rr;
      return rec(p, m, L, depth + 1) + rec(m, q, Rr, depth + 1);
    };
    return rec(a, b, gl(a, b), 0);
  }
  const fnCache = new Map();
  function compiled(src, vars) {
    const key = src + '|' + vars.join(',');
    if (!fnCache.has(key)) { if (fnCache.size > 500) fnCache.clear(); fnCache.set(key, numFn(src, vars, 'evalf')); }
    return fnCache.get(key);
  }
  // valor numérico de uma expressão Maple que pode conter int/Int/sum aninhados; env = {variável: número}
  function numEval(src, env) {
    src = src.trim();
    while (isWrapped(src, '(', ')')) src = unwrap(src).trim();
    const cm = /^(int|Int|integrate)\s*\(/.exec(src);
    if (cm && matchClose(src, src.indexOf('(')) === src.length - 1) {
      const args = splitTop(src.slice(src.indexOf('(') + 1, -1));
      const ranges = isWrapped(args[1], '[', ']') ? listOrSet(args[1]) : [args[1]];
      // int(f, [x = .., y = ..]): x é a mais interna
      let body = args[0];
      for (const r of ranges) body = `Int(${body}, ${r})`;
      if (ranges.length > 1) return numEval(body, env);
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*\.\.\s*([\s\S]+)$/.exec(args[1]);
      if (!m) throw err('evalf', 'definite integral expected, e.g. Int(f, x = 0 .. 1)');
      const v = m[1], a = numEval(m[2], env), b = numEval(m[3], env);
      return quad(t => numEval(args[0], Object.assign({}, env, { [v]: t })), a, b, 1e-9);
    }
    const sm = /^(sum|Sum|add)\s*\(/.exec(src);
    if (sm && matchClose(src, src.indexOf('(')) === src.length - 1) {
      const args = splitTop(src.slice(src.indexOf('(') + 1, -1));
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*\.\.\s*([\s\S]+)$/.exec(args[1]);
      const v = m[1], a = numEval(m[2], env), b = /infinity/.test(m[3]) ? Infinity : numEval(m[3], env);
      return numSum(k => numEval(args[0], Object.assign({}, env, { [v]: k })), a, b);
    }
    // expressão com integrais internas: substitui cada int(...) pelo seu valor numérico
    if (/\b(int|Int|sum|Sum)\s*\(/.test(src)) {
      let out = '', i = 0;
      while (i < src.length) {
        const mm = /^(int|Int|sum|Sum)\s*\(/.exec(src.slice(i));
        if (mm && !/\w/.test(src[i - 1] || '')) { const k = matchClose(src, i + mm[1].length); out += `(${numEval(src.slice(i, k + 1), env)})`; i = k + 1; continue; }
        out += src[i++];
      }
      src = out;
    }
    const vars = Object.keys(env);
    const fn = compiled(src, vars);
    return fn(...vars.map(v => env[v]));
  }
  function numSum(term, a, b) {
    if (isFinite(b)) { let s = 0; for (let k = a; k <= b; k++) s += term(k); return s; }
    // soma infinita: soma direta + aceleração para séries alternadas
    let s = 0, k = a, prev = 0; const partial = [];
    for (; k < a + 20000; k++) { const t = term(k); if (!isFinite(t)) return NaN; s += t; partial.push(s); if (Math.abs(t) < 1e-17 * Math.max(1, Math.abs(s)) && k > a + 20) break; prev = t; }
    // média de Euler simples para alternadas
    const n = partial.length;
    if (n > 100 && Math.sign(term(a + n - 1)) !== Math.sign(term(a + n - 2))) return (partial[n - 1] + partial[n - 2]) / 2;
    return s;
  }

  // ---------- somas simbólicas (finitas com n simbólico e séries infinitas conhecidas) ----------
  function polyInterpSum(term, v, a, b) {
    // Σ_{v=a}^{b} P(v) para P polinomial: Q(m) = Σ_{v=a}^{m} P(v) por interpolação
    const P = nd(`expand(${term})`).toString();
    const d = degIn(P, v);
    if (d > 12) return null;
    const pts = [];
    let acc = '0';
    for (let j = 0; j <= d + 1; j++) { acc = nd(`(${acc})+(${nd(P, { [v]: `(${a})+${j}` }).toString()})`).toString(); pts.push(acc); }
    const m = 'msumvar';
    const terms = pts.map((y, j) => {
      const num = pts.map((_, k) => (k === j ? null : `(${m}-(${a})-${k})`)).filter(Boolean).join('*') || '1';
      const den = pts.map((_, k) => (k === j ? null : `(${j - k})`)).filter(Boolean).join('*') || '1';
      return `(${y})*${num}/(${den})`;
    });
    const Q = nd(`expand(${terms.join('+')})`).toString();
    return nd(`factor(${nd(Q, { [m]: `(${b})` }).toString()})`).toString();
  }
  function harmonic(m) { let s = '0'; for (let k = 1; k <= m; k++) s = nd(`(${s})+1/${k}`).toString(); return s; }
  function infiniteSum(term, v, a) {
    const A = N(a);
    const t = nd(term).toString();
    // geométrica: c * r^v
    try {
      const r = nd(`simplify((${nd(t, { [v]: `(${v})+1` }).toString()})/(${t}))`).toString();
      if (!nd(r).variables().includes(v)) {
        const rv = N(r);
        if (isFinite(rv)) {
          if (Math.abs(rv) >= 1) return nd(t, { [v]: `(${a})` }).toString() === '0' ? null : (rv > 0 ? 'Infinity' : null);
          return nd(`simplify((${nd(t, { [v]: `(${a})` }).toString()})/(1-(${r})))`).toString();
        }
        if (!nd(r).variables().length) return null;
        // razão simbólica (ex.: x/n…) não serve; razão simbólica constante em v (ex.: x): fórmula geométrica
        return nd(`simplify((${nd(t, { [v]: `(${a})` }).toString()})/(1-(${r})))`).toString();
      }
    } catch (e) {}
    // série exponencial c*x^n/n!: m = termo*n! tem razão constante em n
    {
      try {
        const m = nd(`simplify((${t})*factorial(${v}))`).toString();
        const ratio = k => nd(`(${nd(m, { [v]: String(k + 1) }).toString()})/(${nd(m, { [v]: String(k) }).toString()})`).toString();
        const r1 = nd(`simplify(${ratio(3)})`).toString(), r2 = nd(`simplify(${ratio(7)})`).toString();
        if (A === 0 && !/factorial/.test(m) && nd(`simplify((${r1})-(${r2}))`).toString() === '0' && r1 !== '1') return nd(`simplify((${nd(m, { [v]: '0' }).toString()})*e^(${r1}))`).toString();
      } catch (e) {}
    }
    {
      const m = nd(`simplify((${t})*factorial(${v}))`).toString();
      try {
        const r = nd(`simplify((${nd(m, { [v]: `(${v})+1` }).toString()})/(${m}))`).toString();
        if (!nd(r).variables().includes(v) && A === 0 && !/factorial/.test(m)) return nd(`simplify((${nd(m, { [v]: '0' }).toString()})*e^(${r}))`).toString();
      } catch (e) {}
    }
    // p-séries e alternadas: c/n^p, c*(-1)^n/n
    const pm = /^\(?(-?\d+(?:\/\d+)?)?\)?\*?\(?(\w+)\)?\^\(?-(\d+)\)?$/.exec(t.replace(/\s/g, ''));
    const pser = (() => { try { const p = -Number(nd(`simplify(log(abs(${t}))/log(${v}))`, {}).toString()); return null; } catch (e) { return null; } })();
    const ZETA = { 2: 'pi^2/6', 4: 'pi^4/90', 6: 'pi^6/945', 8: 'pi^8/9450' };
    for (const p of [1, 2, 3, 4, 5, 6, 8]) {
      for (const c of ['1', '-1']) {
        // c / v^p
        if (nd(`simplify((${t})-(${c})/(${v})^${p})`).toString() === '0') {
          if (p === 1) return c === '1' ? 'Infinity' : '-Infinity';
          const z = ZETA[p] ? ZETA[p] : `Zeta(${p})`;
          const head = A >= 1 ? Array.from({ length: A - 1 }, (_, k) => `1/${k + 1}^${p}`).join('+') || '0' : null;
          if (head === null) return null;
          if (!ZETA[p]) return { value: `Zeta(${p})`, tex: `${c === '-1' ? '-' : ''}\\zeta\\left(${p}\\right)${head !== '0' ? `-${tex(nd(head).toString())}` : ''}` };
          return nd(`(${c})*((${z})-(${head}))`).toString();
        }
        // (-1)^v / v  e (-1)^(v+1)/v
        if (p === 1 && A === 1) {
          if (nd(`simplify((${t})-(${c})*(-1)^(${v})/(${v}))`).toString() === '0') return nd(`(${c})*(-log(2))`).toString();
          if (nd(`simplify((${t})-(${c})*(-1)^(${v}+1)/(${v}))`).toString() === '0') return nd(`(${c})*log(2)`).toString();
        }
      }
    }
    // função racional: telescópica por frações parciais; divergente se grau(den) - grau(num) <= 1
    try {
      const num = nd(`expand(${nd(t).symbol.getNum().text()})`).toString(), den = nd(`expand(${nd(t).symbol.getDenom().text()})`).toString();
      const dn = degIn(num, v), dd = degIn(den, v);
      if (dn < 99 && dd < 99 && dd >= 1 && !/\^\(?[a-z]/i.test(t)) {
        if (dd - dn <= 1) { const s = N(nd(t, { [v]: '1000' }).toString()); return s > 0 ? 'Infinity' : '-Infinity'; }
        const pf = nd(`partfrac(${t},${v})`).toString();
        const terms = splitSum(pf);
        let total = '0', sumA = '0', ok = true;
        for (const term0 of terms) {
          // A/(v + c)
          const den1 = nd(term0).symbol.getDenom().text(), num1 = nd(term0).symbol.getNum().text();
          if (degIn(den1, v) !== 1 || nd(num1).variables().includes(v)) { ok = false; break; }
          const lead = nd(`coeffs(${den1},${v})`).toString().replace(/^\[|\]$/g, '');
          const [c0, c1] = splitTop(lead);
          const Acoef = nd(`(${num1})/(${c1})`).toString(), shift = nd(`(${c0})/(${c1})`).toString();
          if (!/^-?\d+$/.test(shift)) { ok = false; break; }
          sumA = nd(`(${sumA})+(${Acoef})`).toString();
          const start = A + Number(shift); // Σ_{n=a}^∞ A/(n+s) = A * (−H_{a+s−1}) + divergente comum
          total = nd(`(${total})-(${Acoef})*(${harmonic(start - 1)})`).toString();
        }
        if (ok && nd(`simplify(${sumA})`).toString() === '0') return nd(`simplify(${total})`).toString();
      }
    } catch (e) {}
    return null;
  }

  // ---------- simplificação trigonométrica (sin² + cos² = 1) ----------
  function trigSimplify(s) {
    const cands = [s];
    try {
      const a = nd(`simplify(expand(${s.replace(/sin\(([^()]*(?:\([^()]*\)[^()]*)*)\)\^2/g, '(1-cos($1)^2)')}))`).toString(); cands.push(a);
      const b = nd(`simplify(expand(${s.replace(/cos\(([^()]*(?:\([^()]*\)[^()]*)*)\)\^2/g, '(1-sin($1)^2)')}))`).toString(); cands.push(b);
      cands.push(nd(`factor(${a})`).toString());
    } catch (e) {}
    const ok = cands.filter(c => { try { nd(c); return true; } catch (e) { return false; } });
    return ok.sort((p, q) => p.length - q.length)[0];
  }

  // ---------- comandos de Cálculo 2 ----------
  const varsOf = a => listOrSet(a).map(x => x.trim());
  const colVec = items => `matrix(${items.map(x => `[${x}]`).join(',')})`;
  function hessianRows(f, vars) { return vars.map(a => vars.map(b => nd(`diff(diff(${f},${a}),${b})`).toString())); }
  function pointPairs(arg) { // [x, y] = [1, 2]  ->  {x: '1', y: '2'}
    const e = parseEq(arg);
    if (!e) throw err(null, `expecting a point like [x, y] = [1, 2], got ${arg}`);
    const vs = varsOf(e.lhs), ps = listOrSet(e.rhs).map(tr);
    return { vars: vs, pt: Object.fromEntries(vs.map((v, i) => [v, ps[i]])) };
  }
  const at = (expr, pt) => nd(`simplify(${nd(expr, Object.fromEntries(Object.entries(pt).map(([k, v]) => [k, `(${v})`]))).toString()})`).toString();

  const CALC2 = {
    // VectorCalculus / Student[MultivariateCalculus]
    Gradient(args) {
      if (/=/.test(args[1] || '')) { const { vars, pt } = pointPairs(args[1]); const f = tr(args[0]); return R(colVec(vars.map(v => at(nd(`diff(${f},${v})`).toString(), pt)))); }
      const f = tr(args[0]), vars = varsOf(args[1]);
      return R(colVec(vars.map(v => nd(`diff(${f},${v})`).toString())));
    },
    Hessian(args) {
      const f = tr(args[0]);
      if (/=/.test(args[1] || '')) { const { vars, pt } = pointPairs(args[1]); return R(`matrix(${hessianRows(f, vars).map(r => '[' + r.map(x => at(x, pt)).join(',') + ']').join(',')})`); }
      const vars = varsOf(args[1]);
      return R(`matrix(${hessianRows(f, vars).map(r => '[' + r.join(',') + ']').join(',')})`);
    },
    Jacobian(args) {
      const fs = toList(tr(args[0])), vars = varsOf(args[1]);
      return R(`matrix(${fs.map(f => '[' + vars.map(v => nd(`diff(${f},${v})`).toString()).join(',') + ']').join(',')})`);
    },
    Laplacian(args) { const f = tr(args[0]); return R(nd(varsOf(args[1]).map(v => `diff(${f},${v},2)`).join('+')).toString()); },
    Divergence(args) { const F = toList(tr(args[0])), vars = varsOf(args[1]); return R(nd(F.map((c, i) => `diff(${c},${vars[i]})`).join('+')).toString()); },
    Curl(args) {
      const [P, Q, Rz] = toList(tr(args[0])), [x, y, z] = varsOf(args[1]);
      const d = (f, v) => `diff(${f},${v})`;
      return R(colVec([`${d(Rz, y)}-${d(Q, z)}`, `${d(P, z)}-${d(Rz, x)}`, `${d(Q, x)}-${d(P, y)}`].map(e => nd(e).toString())));
    },
    DirectionalDiff(args) { // VectorCalculus: DirectionalDiff(f, [x, y], [a, b]) — usa o vetor unitário
      const f = tr(args[0]), vars = varsOf(args[1]), u = toList(tr(args[2]));
      const norm = `sqrt(${u.map(c => `(${c})^2`).join('+')})`;
      return R(nd(`simplify((${vars.map((v, i) => `diff(${f},${v})*(${u[i]})`).join('+')})/(${norm}))`).toString());
    },
    DirectionalDerivative(args) { // Student: DirectionalDerivative(f, [x, y] = [a, b], [u1, u2])
      const f = tr(args[0]);
      const { vars, pt } = pointPairs(args[1]);
      const u = toList(tr(args[2]));
      const norm = `sqrt(${u.map(c => `(${c})^2`).join('+')})`;
      const dd = nd(`(${vars.map((v, i) => `(${nd(`diff(${f},${v})`).toString()})*(${u[i]})`).join('+')})/(${norm})`).toString();
      return R(at(dd, pt));
    },
    TangentPlane(args) { // Student: TangentPlane(f, [x, y] = [a, b]) — devolve a expressão do plano
      const f = tr(args[0]);
      const { vars, pt } = pointPairs(args[1]);
      const plane = `${at(f, pt)}+${vars.map(v => `(${at(nd(`diff(${f},${v})`).toString(), pt)})*(${v}-(${pt[v]}))`).join('+')}`;
      return R(nd(`expand(${plane})`).toString());
    },
    SecondDerivativeTest(args) {
      const f = tr(args[0]);
      const e = parseEq(args[1]);
      const vars = varsOf(e.lhs);
      const pts = listOrSet(e.rhs).map(p => listOrSet(p).map(tr));
      const H = hessianRows(f, vars);
      const groups = { LocalMin: [], LocalMax: [], Saddle: [], Inconclusive: [] };
      for (const p of pts) {
        const pt = Object.fromEntries(vars.map((v, i) => [v, p[i]]));
        const Hp = H.map(r => r.map(x => N(at(x, pt))));
        const det = vars.length === 2 ? Hp[0][0] * Hp[1][1] - Hp[0][1] * Hp[1][0] : null;
        const label = vars.length !== 2 ? 'Inconclusive' : det > 1e-12 ? (Hp[0][0] > 0 ? 'LocalMin' : 'LocalMax') : det < -1e-12 ? 'Saddle' : 'Inconclusive';
        groups[label].push(`[${p.join(', ')}]`);
      }
      const t = Object.entries(groups).map(([k, v]) => `\\mathit{${k}} = \\left[${v.map(s => tex(nd(s).toString())).join(',\\,')}\\right]`).join(',\\quad ');
      return { value: '[]', tex: t };
    },
    LagrangeMultipliers(args) { // Student: LagrangeMultipliers(f, [g1, ...], [x, y])
      const f = tr(args[0]), gs = listOrSet(args[1]).map(eqToExpr), vars = varsOf(args[2]);
      const lams = gs.map((_, i) => `lambdavar${i + 1}`);
      const eqs = vars.map(v => `diff(${f},${v})-(${gs.map((g, i) => `${lams[i]}*diff(${g},${v})`).join('+')})`).map(e => nd(e).toString()).concat(gs);
      const all = vars.concat(lams);
      const sols = dedupeSols(solveSys(eqs, all) || [], all, eqs).filter(s => vars.every(v => !/\bi\b/.test(nd(s[v]).toString())));
      const pts = sols.map(s => `[${vars.map(v => s[v]).join(', ')}]`);
      return { value: `[${pts.join(',')}]`, tex: `\\left[${pts.map(p => tex(nd(p).toString())).join(',\\; ')}\\right]` };
    },
    CriticalPoints(args) {
      const f = tr(args[0]), vars = varsOf(args[1]);
      const eqs = vars.map(v => nd(`diff(${f},${v})`).toString());
      const sols = dedupeSols(solveSys(eqs, vars) || [], vars, eqs).filter(sl => vars.every(v => !/\bi\b/.test(nd(sl[v]).toString())));
      return seqR(sols.map(s => ({ value: `[${vars.map(v => `${v}=${s[v]}`).join(',')}]`, tex: `\\left\\{${vars.map(v => `${v} = ${tex(s[v])}`).join(',\\, ')}\\right\\}` })));
    },
    MultiInt(args) { // Student: MultiInt(f, x = a .. b, y = c .. d) — a primeira faixa é a mais interna
      let body = args[0];
      for (const r of args.slice(1).filter(a => /\.\./.test(a))) body = `int(${body}, ${r})`;
      return evalExpr(body);
    },
    TaylorApproximation(args) { return CALC2.mtaylor([args[0], args[1].replace(/^\s*\[([^\]]*)\]\s*=\s*\[([^\]]*)\]\s*$/, (m, a, b) => '[' + a.split(',').map((v, i) => `${v.trim()} = ${b.split(',')[i].trim()}`).join(', ') + ']'), args[2] !== undefined ? String(N(tr(args[2])) + 1) : '3']); },
    mtaylor(args) { // mtaylor(f, [x = a, y = b], n): termos de grau total < n
      const f = tr(args[0]);
      const pts = listOrSet(args[1]).map(p => { const e = parseEq(p); return e ? [e.lhs.trim(), tr(e.rhs)] : [p.trim(), '0']; });
      const n = args[2] !== undefined ? N(tr(args[2])) : 6;
      const sub = Object.fromEntries(pts.map(([v, a]) => [v, `(${a})+tmtvar*((${v})-(${a}))`]));
      let g = nd(f, sub).toString(), fact = 1; const terms = [];
      for (let k = 0; k < n; k++) {
        if (k > 0) fact *= k;
        const c = nd(`simplify(${nd(g, { tmtvar: '0' }).toString()})`).toString();
        if (c !== '0') terms.push(`(${c})/${fact}`);
        g = nd(`diff(${g},tmtvar)`).toString();
      }
      return R(nd(`expand(${terms.join('+') || '0'})`).toString());
    },
    VectorField(args) { return R(tr(args[0])); },
    SetCoordinates() { return { none: true }; },
    Zeta(args) { const p = N(tr(args[0])); const Z = { 2: 'pi^2/6', 4: 'pi^4/90', 6: 'pi^6/945' }; return Z[p] ? R(nd(Z[p]).toString()) : { value: `Zeta(${p})`, tex: `\\zeta\\left(${p}\\right)` }; },
    combine(args) { return R(trigSimplify(nd(tr(args[0])).toString())); },
  };

  /* ======================= Instruções ======================= */

  // substitui %, %%, %%% pelo histórico
  function substHistory(src) {
    return src.replace(/"[^"]*"|%{1,3}/g, m => {
      if (m[0] === '"') return m;
      const k = state.history.length - m.length;
      if (k < 0) throw err(null, 'no previous result to refer to with ' + m);
      const v = state.history[k];
      return /=|^\[/.test(v) ? v : '(' + v + ')';
    });
  }

  function arrowFn(rhs) {
    const m = /^\s*(?:\(\s*([\w\s,]*)\s*\)|([A-Za-z_]\w*))\s*->\s*([\s\S]+)$/.exec(rhs);
    if (!m) return null;
    const params = (m[1] !== undefined ? m[1] : m[2]).split(',').map(s => s.trim()).filter(Boolean);
    return { params, body: m[3] };
  }

  function evalStatement(src) {
    if (/^restart$/.test(src)) { reset(); return { none: true }; }

    // Digits := n
    let m = /^Digits\s*:=\s*([\s\S]+)$/.exec(src);
    if (m) { state.digits = Math.max(1, Math.round(N(tr(m[1])))); return { value: String(state.digits), tex: `\\mathit{Digits} := ${state.digits}` }; }

    // atribuição
    m = /^([A-Za-z_]\w*)\s*:=\s*([\s\S]+)$/.exec(src);
    if (m) {
      const [, name, rhs0] = m;
      if (CONST[name] || name === 'Digits') throw err(null, `attempting to assign to \`${name}\` which is protected`);
      const rhs = substHistory(rhs0);
      // F := proc(n) ... end proc
      if (/^proc\s*\(/.test(rhs.trim())) {
        const P = parseProc(rhs);
        state.procs.set(name, P); state.funcs.delete(name); state.plots.delete(name);
        return { value: name, tex: `${name} := \\texttt{${texEscape(P.src.replace(/\s+/g, ' '))}}`, noHistory: true };
      }
      // f := x -> expr
      const fnDef = arrowFn(rhs);
      if (fnDef) return defineFn(name, fnDef.params, tr(fnDef.body));
      // f := unapply(expr, x)
      const un = /^unapply\s*\(([\s\S]*)\)$/.exec(rhs.trim());
      if (un) { const a = splitTop(un[1]); return defineFn(name, a.slice(1).map(s => s.trim()), tr(a[0])); }
      // x := 'x'  (desatribuir)
      if (rhs.trim() === `'${name}'`) { CMD.unassign([name]); return { value: name, tex: `${name} := ${name}` }; }
      const r = evalExpr(preD(rhs));
      if (r.fn) return defineFn(name, r.fn.params, r.fn.body);
      if (r.plot) { state.plots.set(name, r.plot); clearUserVar(name); return r; }
      if (r.none) return r;
      state.plots.delete(name); state.procs.delete(name);
      setUserVar(name, r.value);
      return { value: r.value, tex: `${name} := ${r.tex}` };
    }
    const s = substHistory(src);
    const fnDef = arrowFn(s);
    if (fnDef) return { value: '0', tex: `${fnDef.params.length === 1 ? fnDef.params[0] : `\\left(${fnDef.params.join(', ')}\\right)`} \\mapsto ${tex(tr(fnDef.body))}`, noHistory: true };
    return evalExpr(preD(s));
  }

  function texEscape(t) { return t.replace(/\\/g, '\\textbackslash ').replace(/([{}$&#^_%~])/g, '\\$1'); }
  function defineFn(name, params, body) {
    state.plots.delete(name); state.procs.delete(name);
    nd.setFunction(name, params, nd(body).toString());
    state.funcs.set(name, { params, body: nd(body).toString() });
    const p = params.length === 1 ? params[0] : `\\left(${params.join(', ')}\\right)`;
    return { value: name, tex: `${name} := ${p} \\mapsto ${tex(body)}`, noHistory: true };
  }

  function evalExpr(src) {
    src = pkgPrefix(src.trim());
    if (isString(src)) return { value: src, tex: `\\text{${texEscape(src)}}` };
    // chamada de comando no nível superior: preserva a forma da saída (sequências, gráficos…)
    const cm = /^([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\(/.exec(src);
    const cname = cm ? cm[1].replace(/^PKGOK__/, '') : null;
    if (cm && CMD[cname] && !state.procs.has(cname)) {
      const open = src.indexOf('(', cm[0].length - 1);
      if (matchClose(src, open) === src.length - 1) {
        const args = splitTop(src.slice(open + 1, -1));
        return CMD[cmdName(cm[1])](args, cm[2] ? cm[2].slice(1, -1) : null);
      }
    }
    // sequência de expressões: a, b, c
    const parts = splitTop(src);
    if (parts.length > 1 && !/^\s*$/.test(parts[0])) return seqR(parts.map(x => { const r = evalExpr(x); return { value: r.value, tex: r.tex }; }));
    // conjuntos / listas
    if (isWrapped(src, '{', '}') || isWrapped(src, '[', ']')) {
      const items = listOrSet(src).flatMap(x => {
        const e = parseEq(x);
        if (e) { const l = tr(e.lhs), r = tr(e.rhs); return [{ value: `${l}=${r}`, tex: eqTeX(l, r) }]; }
        if (isString(x)) return [{ value: x, tex: `\\text{${texEscape(x)}}` }];
        return seqItems(x).map(v => { v = nd(v).toString(); return { value: v, tex: tex(v) }; });
      });
      return seqR(items, src.trim()[0] === '{' ? '{' : '[');
    }
    // equação simples
    const e = parseEq(src);
    if (e && !/[<>]/.test(src)) {
      const L = sideR(e.lhs), Rr = sideR(e.rhs);
      return { value: `${L.value}=${Rr.value}`, tex: `${L.tex} = ${Rr.tex}` };
    }
    const hasFloat = /(^|[^\w.])\d*\.\d+|\d+\.(?!\.)/.test(src);
    const t0 = tr(src);
    if (isString(t0.trim())) return { value: t0.trim(), tex: `\\text{${texEscape(t0.trim())}}` };
    if (/=/.test(t0) && !/[<>]/.test(t0)) { const q = parseEq(t0); if (q) return { value: t0, tex: eqTeX(q.lhs, q.rhs) }; }
    const v = nd(t0).toString();
    if (hasFloat) {
      const txt = nd(v).evaluate().text('decimals');
      const s = /^-?[\d.]+(e[+-]?\d+)?$/.test(txt) ? shortFloat(Number(txt)) : floatify(txt, state.digits);
      return { value: v, tex: floatTeX(s) };
    }
    if (v === 'true' || v === 'false') return { value: v, tex: `\\mathit{${v}}` };
    return R(v);
  }

  function sideR(s) { // um lado de equação: comandos inertes (Diff, Int…) mantêm a forma
    s = pkgPrefix(s.trim());
    const cm = /^([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\(/.exec(s);
    if (cm && CMD[cm[1].replace(/^PKGOK__/, '')] && matchClose(s, s.indexOf('(', cm[0].length - 1)) === s.length - 1) {
      const r = CMD[cmdName(cm[1])](splitTop(s.slice(s.indexOf('(', cm[0].length - 1) + 1, -1)), cm[2] ? cm[2].slice(1, -1) : null);
      if (r.tex !== undefined) return r;
    }
    const v = nd(tr(s)).toString();
    return { value: v, tex: tex(v) };
  }

  function friendlyError(e, src) {
    if (e instanceof MapleError) return e.message;
    const msg = (e && e.message) || String(e);
    if (/Maximum call stack/.test(msg)) return 'Error, recursive assignment';
    if (/is not a valid|Unexpected|unexpected/i.test(msg)) return `Error, invalid input: ${msg}`;
    return `Error, ${msg}`;
  }

  // o nome i do usuário vira iI por dentro (no motor, i é a unidade imaginária; no Maple ela é I)
  function renameI(text) {
    return text.replace(/"[^"]*"|\bi\b/g, m => (m[0] === '"' ? m : 'iI'));
  }

  // Avalia o texto de uma célula (pode conter várias instruções, laços, if e proc)
  function evaluateCell(text) {
    const ctx = { blocks: [], show: true, inProc: false };
    for (const st of splitStatements(renameI(text))) {
      try {
        state.procOut = []; state.depth = 0;
        ctx.show = st.show;
        execStatement(st.src, ctx);
      } catch (e) {
        if (state.procOut.length) ctx.blocks.push(...state.procOut);
        if (e instanceof Signal) ctx.blocks.push({ error: e.kind === 'return' ? 'Error, return out of context' : `Error, ${e.kind} out of context` });
        else ctx.blocks.push({ error: friendlyError(e, st.src).replace(/iI/g, 'i') });
        break;
      }
    }
    return ctx.blocks.map(b => (b.note ? { note: b.note.replace(/iI/g, 'i') } : b));
  }

  Object.assign(CMD, PLOTS, FLOW, CALC2);
  // pacote linalg (antigo, ainda muito usado em cursos)
  Object.assign(CMD, { grad: CALC2.Gradient, hessian: CALC2.Hessian, jacobian: CALC2.Jacobian, laplacian: CALC2.Laplacian, diverge: CALC2.Divergence, curl: CALC2.Curl,
    det: a => CMD.Determinant(a), inverse: a => CMD.MatrixInverse(a), transpose: a => CMD.Transpose(a) });
  global.MapleKernel = { evaluateCell, reset, state, _internals: { solveSys, dedupeSols, factorList, infiniteSum } };
  if (typeof module !== 'undefined') module.exports = global.MapleKernel;
}
MapleKernelFactory(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports.MapleKernelFactory = MapleKernelFactory;
