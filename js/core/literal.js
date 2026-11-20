/* ============================================================
   Safe parser for pasted question arrays (Phase 11).

   The import box accepts the JavaScript-style array the AI prompt asks
   for. It used to be run with `new Function`, which meant a pasted array
   could run any script. This parser reads data only:

     arrays, objects (bare, quoted or numeric keys), strings in ' " or `,
     numbers, true / false / null / undefined, line and block comments,
     trailing commas, and a leading `const questions =` with a final `;`.

   Backtick strings are plain text: `${x}` stays as the characters
   "${x}", it is never evaluated. Anything else (function calls,
   operators, identifiers as values) is a SyntaxError with its line, in the
   "Unexpected token" wording formatManualImportParseError() understands.
   ============================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { literal: api });
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const MAX_DEPTH = 64;
    const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

    function parse(source) {
        const src = String(source == null ? '' : source);
        let i = 0;

        function lineOf(pos) { return src.slice(0, pos).split('\n').length; }
        function fail(what, pos) {
            const at = pos == null ? i : pos;
            const err = new SyntaxError(`${what} at line ${lineOf(at)}`);
            err.position = at;
            throw err;
        }
        function unexpected(pos) {
            const at = pos == null ? i : pos;
            if (at >= src.length) fail('Unexpected end of input', at);
            const m = /^[A-Za-z_$][\w$]*|^\S/.exec(src.slice(at));
            fail(`Unexpected token '${m ? m[0] : src[at]}'`, at);
        }

        function skip() {
            for (;;) {
                const ch = src[i];
                if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿' || ch === ' ') { i++; continue; }
                if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e + 1; continue; }
                if (src.startsWith('/*', i)) {
                    const e = src.indexOf('*/', i + 2);
                    if (e < 0) fail('Unterminated comment', i);
                    i = e + 2;
                    continue;
                }
                return;
            }
        }

        function string() {
            const quote = src[i];
            const start = i;
            i++;
            let out = '';
            while (i < src.length) {
                const ch = src[i];
                if (ch === quote) { i++; return out; }
                if (ch === '\\') {
                    const n = src[i + 1];
                    if (n === undefined) break;
                    if (n === '\r' && src[i + 2] === '\n') { i += 3; continue; } // line continuation
                    if (n === '\n' || n === '\r') { i += 2; continue; }
                    if (n === 'u') {
                        let hex = '';
                        let len = 6;
                        if (src[i + 2] === '{') {
                            const close = src.indexOf('}', i + 3);
                            hex = close > 0 ? src.slice(i + 3, close) : '';
                            len = close > 0 ? close - i + 1 : 0;
                        } else {
                            hex = src.slice(i + 2, i + 6);
                        }
                        if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || !len) fail('Invalid Unicode escape', i);
                        out += String.fromCodePoint(parseInt(hex, 16));
                        i += len;
                        continue;
                    }
                    if (n === 'x') {
                        const hex = src.slice(i + 2, i + 4);
                        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('Invalid hexadecimal escape', i);
                        out += String.fromCharCode(parseInt(hex, 16));
                        i += 4;
                        continue;
                    }
                    out += Object.prototype.hasOwnProperty.call(ESCAPES, n) ? ESCAPES[n] : n;
                    i += 2;
                    continue;
                }
                if ((ch === '\n' || ch === '\r') && quote !== '`') fail('Unterminated string', start);
                out += ch === '\r' && quote === '`' ? (src[i + 1] === '\n' ? '' : '\n') : ch;
                i++;
            }
            fail(quote === '`' ? 'Unterminated template literal' : 'Unterminated string', start);
        }

        function number() {
            const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
            if (!m || m[0] === '-') unexpected();
            i += m[0].length;
            return Number(m[0].replace(/_/g, ''));
        }

        function word() {
            const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
            return m ? m[0] : '';
        }

        function key() {
            const ch = src[i];
            if (ch === '"' || ch === "'" || ch === '`') return string();
            if (/[0-9]/.test(ch)) return String(number());
            const w = word();
            if (!w) unexpected();
            i += w.length;
            return w;
        }

        function value(depth) {
            if (depth > MAX_DEPTH) fail('Nesting is too deep', i);
            skip();
            const ch = src[i];
            if (ch === '[') {
                i++;
                const arr = [];
                for (;;) {
                    skip();
                    if (src[i] === ']') { i++; return arr; }
                    arr.push(value(depth + 1));
                    skip();
                    if (src[i] === ',') { i++; continue; }
                    if (src[i] === ']') { i++; return arr; }
                    unexpected();
                }
            }
            if (ch === '{') {
                i++;
                // No prototype, so keys like "__proto__" are plain data.
                const obj = Object.create(null);
                for (;;) {
                    skip();
                    if (src[i] === '}') { i++; return toPlain(obj); }
                    const k = key();
                    skip();
                    if (src[i] !== ':') unexpected();
                    i++;
                    obj[k] = value(depth + 1);
                    skip();
                    if (src[i] === ',') { i++; continue; }
                    if (src[i] === '}') { i++; return toPlain(obj); }
                    unexpected();
                }
            }
            if (ch === '"' || ch === "'" || ch === '`') return string();
            if (ch === '-' || ch === '.' || /[0-9]/.test(ch || '')) return number();
            const w = word();
            if (w === 'true') { i += 4; return true; }
            if (w === 'false') { i += 5; return false; }
            if (w === 'null') { i += 4; return null; }
            if (w === 'undefined') { i += 9; return undefined; }
            unexpected();
        }

        // A plain object whose own keys are exactly the parsed ones.
        function toPlain(obj) {
            const out = {};
            Object.keys(obj).forEach((k) => {
                Object.defineProperty(out, k, { value: obj[k], enumerable: true, writable: true, configurable: true });
            });
            return out;
        }

        skip();
        // Accept `const questions = [...]` and `export default [...]` too.
        const decl = /^(?:export\s+default\s+|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)/.exec(src.slice(i));
        if (decl) i += decl[0].length;
        const result = value(0);
        skip();
        if (src[i] === ';') { i++; skip(); }
        if (i < src.length) unexpected();
        return result;
    }

    return { parse };
});
