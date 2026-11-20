// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../../js/core/literal.js');

const AI_OUTPUT = `[
  {
    number: 1,
    // Topic/Subtopic: Example topic
    text: \`Which term is used to describe the first line of an XML document?\`,
    choices: {
      A: \`opening\`,
      B: \`prologue\`,
      "C": 'introduction',
      D: "preamble",
    },
    answer: ["B"],
    answerDescriptions: {
      B: \`The XML declaration is commonly called the XML prologue.\`
    },
    responseType: \`single\`,
    maxSelections: 1
  },
  {
    number: 2,
    text: \`What does this program print?\`,
    code: \`int total = 0;
for (int i = 1; i <= 4; i++)
{
    if (i % 2 == 0) continue;
    total += i;
}
Console.WriteLine($"{total}");\`,
    language: \`csharp\`, challenge: \`output\`,
    choices: { A: \`4\`, B: \`6\` }, answer: ["A"], maxSelections: 1, /* trailing comma next */
  },
];`;

test('parses the shape the AI prompt asks for, exactly like JavaScript would', () => {
    const got = parse(AI_OUTPUT);
    // eslint-disable-next-line no-new-func
    const viaJs = new Function('return ' + AI_OUTPUT.replace(/;\s*$/, ''))(); // trusted fixture only
    assert.deepEqual(got, viaJs);
    assert.equal(got[1].code.split('\n').length, 7);
    assert.equal(got[0].choices.C, 'introduction');
});

test('accepts a leading declaration and a final semicolon', () => {
    assert.deepEqual(parse('const questions = [1, 2];'), [1, 2]);
    assert.deepEqual(parse('export default [{ a: 1 }]'), [{ a: 1 }]);
});

test('escapes, numbers and literals', () => {
    const BT = '`';
    const BS = '\\';
    const src = '["a' + BS + 'tb", \'it' + BS + '\'s\', ' + BT + 'x' + BS + BT + 'y' + BT + ', "'
        + BS + 'u00e9' + BS + 'u{1F600}", "' + BS + 'x41"]';
    assert.deepEqual(parse(src), ['a\tb', "it's", 'x`y', 'é😀', 'A']);
    assert.deepEqual(parse('[-1.5, 2e3, 0x1f, 1_000, .5, true, false, null]'), [-1.5, 2000, 31, 1000, 0.5, true, false, null]);
    assert.deepEqual(parse('{ 1: "one", "two words": 2 }'), { 1: 'one', 'two words': 2 });
});

test('${...} inside backticks stays plain text and is never evaluated', () => {
    globalThis.__pwned = false;
    const got = parse('[`console.log(\\`n=${n}\\`); ${(globalThis.__pwned = true)}`]');
    assert.equal(got[0], 'console.log(`n=${n}`); ${(globalThis.__pwned = true)}');
    assert.equal(globalThis.__pwned, false);
});

test('anything that is not plain data is refused, with its line', () => {
    const cases = [
        '[alert(1)]',
        '[{ text: fetch("/api/auth/logout") }]',
        '[(() => 1)()]',
        '[1 + 2]',
        '[window.location]',
        '[{ a: 1 }].map(x => x)',
        '[new Date()]',
        '["unterminated]',
        '[1, 2',
    ];
    cases.forEach((src) => assert.throws(() => parse(src), SyntaxError, src));
    assert.throws(() => parse('[\n  { text: `ok` },\n  oops\n]'), /Unexpected token 'oops' at line 3/);
});

test('"__proto__" and "constructor" keys are plain data', () => {
    const got = parse('[{ "__proto__": { polluted: true }, constructor: "x" }]');
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf(got[0]), Object.prototype);
    assert.deepEqual(Object.keys(got[0]), ['__proto__', 'constructor']);
    assert.equal(got[0].constructor, 'x');
});

test('deep nesting is limited', () => {
    assert.throws(() => parse('['.repeat(200) + ']'.repeat(200)), /too deep/);
});
