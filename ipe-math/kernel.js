/* Ipê Math — interpretador com a sintaxe de entrada 1-D do Maple.
 * Traduz comandos no estilo Maple para o motor simbólico nerdamer.
 * Exporta: MapleKernel.evaluateCell(texto) -> blocos de saída; MapleKernel.reset(). */
'use strict';

(function (global) {
  const nd = global.nerdamer || (typeof require !== 'undefined' ? require('nerdamer/all.min') : null);

  /* ======================= Estado ======================= */
  const state = { history: [], eqs: new Map(), vars: new Set(), funcs: new Map(), digits: 10, packages: new Set() };

  function reset() {
    state.vars.forEach(v => { try { nd.setVar(v, 'delete'); } catch (e) {} });
    try { nd.clear('all'); } catch (e) {}
    try { nd.clearVars && nd.clearVars(); } catch (e) {}
    state.vars.clear(); state.eqs.clear(); state.funcs.clear(); state.history = []; state.digits = 10; state.packages.clear();
  }

  class MapleError extends Error {}
  const err = (where, msg) => new MapleError(where ? `Error, (in ${where}) ${msg}` : `Error, ${msg}`);

  /* ======================= Utilidades de texto ======================= */

  // Divide por separador no nível superior, respeitando (), [], {} e strings.
  function splitTop(s, sep = ',') {
    const out = []; let depth = 0, cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') q = !q;
      if (!q) {
        if ('([{'.includes(ch)) depth++;
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
    const txt = nd(expr).evaluate().text('decimals');
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
    src = preD(String(src).trim()).replace(/(\d+)!/g, 'factorial($1)').replace(/\b(LinearAlgebra|inttrans|plots|student|Student)\s*:-\s*/g, '');
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
        out += Object.prototype.hasOwnProperty.call(CONST, name) ? CONST[name] : state.eqs.has(name) ? state.eqs.get(name) : name;
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
      if (ch === '{') { // conjunto literal
        const k = matchClose(src, i);
        out += '[' + splitTop(src.slice(i + 1, k)).map(tr).join(',') + ']';
        i = k + 1; continue;
      }
      out += ch; i++;
    }
    // A^(-1) com A matriz -> inversa
    out = out.replace(/(\b[A-Za-z_]\w*)\s*\^\s*\(\s*-1\s*\)/g, (m, name) => isMatrix(name) ? `invert(${name})` : m);
    return out;
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
  function callResult(name, args, sub) {
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
    return { value, tex: t !== undefined ? t : tex(value) };
  };
  const seqR = (items, wrap = '') => { // sequência de expressões
    const t = items.map(x => (typeof x === 'string' ? tex(x) : x.tex)).join(',\\; ');
    const v = '[' + items.map(x => (typeof x === 'string' ? x : x.value)).join(',') + ']';
    return { value: v, tex: wrap === '{' ? `\\left\\{${t}\\right\\}` : wrap === '[' ? `\\left[${t}\\right]` : t };
  };

  /* ======================= Comandos ======================= */

  function simplifyInf(s) {
    return nd(s.replace(/e\^\(-Infinity\)/g, '0').replace(/e\^\(Infinity\)/g, 'Infinity')
      .replace(/atan\(-Infinity\)/g, '(-pi/2)').replace(/atan\(Infinity\)/g, '(pi/2)')).toString();
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
      const f = tr(args[0]);
      if (!args[1]) throw err('int', 'expecting 2 arguments');
      if (args[1].includes('..')) {
        const { v, a, b } = parseRange(args[1], 'int');
        let r;
        try { r = nd(`defint(${f},${a},${b},${v})`).toString(); }
        catch (e) {
          const F = nd(`integrate(${f},${v})`);
          if (/integrate/.test(F.toString())) return R(`int(${f},${v}=${a}..${b})`, `\\int_{${tex(a)}}^{${tex(b)}} ${tex(f)}\\,d${v}`);
          r = nd(`(${nd(F.toString(), { [v]: b })})-(${nd(F.toString(), { [v]: a })})`).toString();
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
      const r = nd(`limit(${f},${e.lhs.trim()},${tr(e.rhs)})`).toString();
      return R(r);
    },
    sum(args) {
      const f = tr(args[0]);
      if (!args[1].includes('..')) throw err('sum', 'indefinite sums are not supported');
      const { v, a, b } = parseRange(args[1], 'sum');
      return R(nd(`sum(${f},${v},${a},${b})`).toString());
    },
    product(args) {
      const f = tr(args[0]); const { v, a, b } = parseRange(args[1], 'product');
      return R(nd(`product(${f},${v},${a},${b})`).toString());
    },
    seq(args) {
      const { v, a, b } = parseRange(args[1], 'seq');
      const lo = N(a), hi = N(b), items = [];
      if (hi - lo > 10000) throw err('seq', 'sequence too long');
      for (let k = lo; k <= hi + 1e-12; k++) items.push(nd(tr(args[0]), { [v]: String(k) }).toString());
      return seqR(items);
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
      const sol = nd.solveEquations(exprs.map(x => `${x}=0`), vars);
      if (!sol || !sol.length) return { value: '[]', tex: '\\text{(no solutions found)}' };
      const items = sol.map(([v, val]) => ({ value: `${v}=${val}`, tex: `${v} = ${tex(String(val))}` }));
      return seqR(items, '{');
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
      const v = tr(args[0]);
      if (isMatrix(v)) return R(v);
      const s = evalfStr(v, digits);
      return { value: s.replace(/ 10\^\((-?\d+)\)/, 'e$1'), tex: floatTeX(s) };
    },
    subs(args) {
      const target = args[args.length - 1];
      let e = tr(target);
      for (const s of args.slice(0, -1).flatMap(listOrSet)) {
        const q = parseEq(s); if (!q) throw err('subs', 'invalid substitution');
        e = nd(e, { [q.lhs.trim()]: tr(q.rhs) }).toString();
      }
      return R(e);
    },
    eval(args) {
      let e = tr(args[0]);
      if (args[1]) for (const s of listOrSet(args[1])) {
        const q = parseEq(s); if (!q) throw err('eval', 'invalid evaluation point');
        e = nd(e, { [q.lhs.trim()]: tr(q.rhs) }).toString();
      }
      return R(nd(e).toString());
    },
    value(args) { return R(tr(args[0])); },
    simplify(args) { return R(nd(`simplify(${tr(args[0])})`).toString()); },
    expand(args) { return R(nd(`expand(${tr(args[0])})`).toString()); },
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

    /* ---------- Gráficos ---------- */
    plot(args) {
      const opts = parseOpts(args.slice(1));
      const fs = isWrapped(args[0], '[', ']') || isWrapped(args[0], '{', '}') ? listOrSet(args[0]) : [args[0]];
      const rng = opts.ranges[0];
      const v = rng ? rng.v : (nd(tr(fs[0])).variables()[0] || 'x');
      const lo = rng ? N(rng.a) : -10, hi = rng ? N(rng.b) : 10;
      const colors = listOpt(opts.named.color);
      const legends = listOpt(opts.named.legend);
      const traces = fs.map((f, idx) => {
        const fn = nd(tr(f)).buildFunction([v]);
        const xs = [], ys = [];
        const M = 800;
        for (let k = 0; k <= M; k++) {
          const t = lo + (hi - lo) * k / M; let y;
          try { y = fn(t); } catch (e) { y = NaN; }
          xs.push(t); ys.push(isFinite(y) && Math.abs(y) < 1e10 ? y : null);
        }
        const tr0 = { x: xs, y: ys, type: 'scatter', mode: 'lines', name: legends[idx] || f, line: { width: 2, color: colors[idx] ? colorName(colors[idx]) : MAPLE_COLORS[idx % MAPLE_COLORS.length] } };
        if (opts.named.style && /point/.test(opts.named.style)) { tr0.mode = 'markers'; tr0.marker = { size: 4 }; }
        return tr0;
      });
      const layout = { xaxis: { title: labelOpt(opts, 0, v) }, yaxis: { title: labelOpt(opts, 1, '') }, showlegend: fs.length > 1 || !!opts.named.legend };
      if (opts.ranges[1]) layout.yaxis.range = [N(opts.ranges[1].a), N(opts.ranges[1].b)];
      else if (opts.yrange) layout.yaxis.range = opts.yrange;
      if (opts.named.title) layout.title = { text: strVal(opts.named.title), font: { size: 14 } };
      return { plot: { data: traces, layout } };
    },
    plot3d(args) {
      const opts = parseOpts(args.slice(1));
      const [rx, ry] = opts.ranges;
      if (!rx || !ry) throw err('plot3d', 'expecting ranges for both variables, e.g. x = -2..2, y = -2..2');
      const fn = nd(tr(args[0])).buildFunction([rx.v, ry.v]);
      const [x0, x1, y0, y1] = [N(rx.a), N(rx.b), N(ry.a), N(ry.b)];
      const G = 60, xs = [], ys = [], zs = [];
      for (let k = 0; k <= G; k++) { xs.push(x0 + (x1 - x0) * k / G); ys.push(y0 + (y1 - y0) * k / G); }
      for (const y of ys) zs.push(xs.map(x => { const z = fn(x, y); return isFinite(z) ? z : null; }));
      const layout = { scene: { xaxis: { title: rx.v }, yaxis: { title: ry.v }, zaxis: { title: '' } } };
      if (opts.named.title) layout.title = { text: strVal(opts.named.title), font: { size: 14 } };
      return { plot: { data: [{ x: xs, y: ys, z: zs, type: 'surface', colorscale: 'Viridis', showscale: false }], layout } };
    },

    /* ---------- Sessão ---------- */
    with(args) {
      const pkg = args[0].trim();
      const EXPORTS = {
        LinearAlgebra: ['CharacteristicPolynomial', 'ColumnDimension', 'CrossProduct', 'Determinant', 'DotProduct', 'Eigenvalues', 'IdentityMatrix', 'LinearSolve', 'MatrixInverse', 'Rank', 'RowDimension', 'Trace', 'Transpose'],
        inttrans: ['invlaplace', 'laplace'],
        plots: ['display'],
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
    add: CMD.sum, mul: CMD.product, inverse: CMD.MatrixInverse,
    Int(a) {
      const r = CMD.int(a); const f = tex(tr(a[0]));
      if (a[1] && a[1].includes('..')) { const g = parseRange(a[1], 'Int'); return { value: r.value, tex: `\\int_{${tex(g.a)}}^{${tex(g.b)}} ${f}\\,d${g.v}` }; }
      return { value: r.value, tex: `\\int ${f}\\,d${(a[1] || 'x').trim()}` };
    },
    Sum(a) { const r = CMD.sum(a), g = parseRange(a[1], 'Sum'); return { value: r.value, tex: `\\sum_{${g.v}=${tex(g.a)}}^{${tex(g.b)}} ${tex(tr(a[0]))}` }; },
    Product(a) { const r = CMD.product(a), g = parseRange(a[1], 'Product'); return { value: r.value, tex: `\\prod_{${g.v}=${tex(g.a)}}^{${tex(g.b)}} ${tex(tr(a[0]))}` }; },
    Limit(a) { const r = CMD.limit(a), e = parseEq(a[1]); return { value: r.value, tex: `\\lim_{${e.lhs.trim()} \\to ${tex(tr(e.rhs))}} ${tex(tr(a[0]))}` }; },
  });

  function series(args, name) {
    const f = tr(args[0]);
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

  const MAPLE_COLORS = ['#c40000', '#0000c4', '#008000', '#c400c4', '#00a0a0', '#c47a00', '#404040'];
  function colorName(c) {
    c = c.replace(/"/g, '').trim();
    const map = { red: '#c40000', blue: '#0000c4', green: '#008000', black: '#000000', magenta: '#c400c4', cyan: '#00a0a0', orange: '#ff8c00', purple: '#800080', brown: '#8b4513', gold: '#d4a017', navy: '#000080', gray: '#808080', grey: '#808080', yellow: '#d4c400' };
    return map[c.toLowerCase()] || c;
  }
  const listOpt = v => (v ? listOrSet(v) : []);
  function labelOpt(opts, i, dflt) { const l = listOpt(opts.named.labels); return l[i] ? strVal(l[i]) : dflt; }
  function parseOpts(args) {
    const ranges = [], named = {};
    for (const a of args) {
      if (a.includes('..') && /^\s*[A-Za-z_]\w*\s*=/.test(a) && !/^\s*(view|title|color|labels|legend|style|thickness)\s*=/.test(a)) ranges.push(parseRange(a));
      else if (/^\s*-?[\d.]+\s*\.\.\s*-?[\d.]+\s*$/.test(a)) { const [p, q] = a.split('..'); ranges.push({ v: '_y', a: p, b: q }); }
      else { const e = parseEq(a); if (e) named[e.lhs.trim()] = e.rhs.trim(); }
    }
    return { ranges, named };
  }

  /* ======================= Instruções ======================= */

  // separa instruções por ; ou : (fora de parênteses e strings), guardando o terminador
  function splitStatements(text) {
    text = text.replace(/#.*$/gm, '');
    const out = []; let depth = 0, cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') q = !q;
      if (!q) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (depth === 0 && (ch === ';' || (ch === ':' && text[i + 1] !== '=' && text[i + 1] !== '-' && text[i + 1] !== ':' && text[i - 1] !== ':'))) {
          if (cur.trim()) out.push({ src: cur.trim(), show: ch === ';' });
          cur = ''; continue;
        }
      }
      cur += ch;
    }
    if (cur.trim()) out.push({ src: cur.trim(), show: true, noTerm: true });
    return out;
  }

  // substitui %, %%, %%% pelo histórico
  function substHistory(src) {
    return src.replace(/%{1,3}/g, m => {
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
      if (r.plot) return r;
      if (r.none) return r;
      if (/=/.test(r.value)) { state.eqs.set(name, r.value); try { nd.setVar(name, 'delete'); } catch (e) {} }
      else { state.eqs.delete(name); nd.setVar(name, r.value); state.vars.add(name); }
      return { value: r.value, tex: `${name} := ${r.tex}` };
    }
    const s = substHistory(src);
    const fnDef = arrowFn(s);
    if (fnDef) return { value: '0', tex: `${fnDef.params.length === 1 ? fnDef.params[0] : `\\left(${fnDef.params.join(', ')}\\right)`} \\mapsto ${tex(tr(fnDef.body))}`, noHistory: true };
    return evalExpr(preD(s));
  }

  function defineFn(name, params, body) {
    nd.setFunction(name, params, nd(body).toString());
    state.funcs.set(name, { params, body: nd(body).toString() });
    const p = params.length === 1 ? params[0] : `\\left(${params.join(', ')}\\right)`;
    return { value: name, tex: `${name} := ${p} \\mapsto ${tex(body)}`, noHistory: true };
  }

  function evalExpr(src) {
    src = src.trim();
    // chamada de comando no nível superior: preserva a forma da saída (sequências, gráficos…)
    const cm = /^([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\(/.exec(src);
    if (cm && CMD[cm[1]]) {
      const open = src.indexOf('(', cm[0].length - 1);
      if (matchClose(src, open) === src.length - 1) {
        const args = splitTop(src.slice(open + 1, -1));
        return CMD[cm[1]](args, cm[2] ? cm[2].slice(1, -1) : null);
      }
    }
    // conjuntos / listas
    if (isWrapped(src, '{', '}') || isWrapped(src, '[', ']')) {
      const items = listOrSet(src).map(x => {
        const e = parseEq(x);
        if (e) { const l = tr(e.lhs), r = tr(e.rhs); return { value: `${l}=${r}`, tex: eqTeX(l, r) }; }
        const v = nd(tr(x)).toString(); return { value: v, tex: tex(v) };
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
    const v = nd(tr(src)).toString();
    if (hasFloat) {
      const txt = nd(v).evaluate().text('decimals');
      const s = /^-?[\d.]+(e[+-]?\d+)?$/.test(txt) ? shortFloat(Number(txt)) : floatify(txt, state.digits);
      return { value: v, tex: floatTeX(s) };
    }
    if (v === 'true' || v === 'false') return { value: v, tex: `\\mathit{${v}}` };
    return R(v);
  }

  function sideR(s) { // um lado de equação: comandos inertes (Diff, Int…) mantêm a forma
    s = s.trim();
    const cm = /^([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\(/.exec(s);
    if (cm && CMD[cm[1]] && matchClose(s, s.indexOf('(', cm[0].length - 1)) === s.length - 1) {
      const r = CMD[cm[1]](splitTop(s.slice(s.indexOf('(', cm[0].length - 1) + 1, -1)), cm[2] ? cm[2].slice(1, -1) : null);
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

  // Avalia o texto de uma célula (pode conter várias instruções)
  function evaluateCell(text) {
    const blocks = [];
    for (const st of splitStatements(text)) {
      try {
        const r = evalStatement(st.src);
        if (r.value !== undefined && !r.noHistory) {
          state.history.push(r.value);
          if (state.history.length > 3) state.history.shift();
        }
        if (!st.show || r.none) continue;
        if (r.plot) blocks.push({ plot: r.plot });
        else if (r.tex !== undefined) blocks.push({ tex: r.tex });
      } catch (e) {
        blocks.push({ error: friendlyError(e, st.src) });
        break;
      }
    }
    return blocks;
  }

  global.MapleKernel = { evaluateCell, reset, state };
  if (typeof module !== 'undefined') module.exports = global.MapleKernel;
})(typeof window !== 'undefined' ? window : globalThis);
