// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const Ln = require('../../js/modes/learn.js');

// Same table as tests/test_learn_api.py: the server and browser must agree.
const NORMALIZE_CASES = [
    ['Paris', 'paris'],
    ['  the Paris!! ', 'paris'],
    ['The  Great   Wall', 'great wall'],
    ['An apple', 'apple'],
    ['a', 'a'],
    ['“HTTP/2”', 'http 2'],
    ["Don't", 'dont'],
    ['TCP-IP', 'tcp ip'],
    ['Théâtre', 'théâtre'],
];

test('normalizeText matches the server rule', () => {
    for (const [raw, expected] of NORMALIZE_CASES) assert.equal(Ln.normalizeText(raw), expected, raw);
});

test('writtenAnswer eligibility matches the server rule', () => {
    assert.equal(Ln.writtenAnswer({ choices: { A: 'Paris', B: 'Rome' }, answer: ['A'] }), 'Paris');
    assert.equal(Ln.writtenAnswer({ choices: { A: 'x', B: 'y' }, answer: ['A', 'B'] }), null);
    assert.equal(Ln.writtenAnswer({ choices: { A: 'All of the above', B: 'x' }, answer: ['A'] }), null);
    assert.equal(Ln.writtenAnswer({ choices: { A: 'word '.repeat(30), B: 'x' }, answer: ['A'] }), null);
    assert.equal(Ln.writtenAnswer({ choices: { A: 'The Paris', B: 'paris!' }, answer: ['A'] }), null);
});

const ids = ['q_1', 'q_2', 'q_3', 'q_4', 'q_5'];
const stages = { q_1: 'mastered', q_2: 'familiar', q_3: 'learning', q_5: 'learning' };

test('countStages treats unknown as new', () => {
    assert.deepEqual(Ln.countStages(ids, stages), { new: 1, learning: 2, familiar: 1, mastered: 1 });
});

test('buildRound: learning, then new, then familiar; mastered left out', () => {
    assert.deepEqual(Ln.buildRound(ids, stages, 10), ['q_3', 'q_5', 'q_4', 'q_2']);
    assert.deepEqual(Ln.buildRound(ids, stages, 2), ['q_3', 'q_5']);
    assert.deepEqual(Ln.buildRound(ids, stages, 10, true).length, 5);
});

test('requeue puts a miss back a few places later, clamped to the end', () => {
    assert.deepEqual(Ln.requeue(['a', 'b', 'c', 'd', 'e'], 0, 'a', 3), ['a', 'b', 'c', 'd', 'a', 'e']);
    assert.deepEqual(Ln.requeue(['a', 'b'], 1, 'b', 3), ['a', 'b', 'b']);
});

test('chooseFormat gets harder as the question matures', () => {
    const single = { choices: { A: 'Paris', B: 'Rome' }, answer: ['A'] };
    const vague = { choices: { A: 'All of the above', B: 'x' }, answer: ['A'] };
    const multi = { choices: { A: '2', B: '3', C: '4' }, answer: ['A', 'C'] };
    const all = { written: true, recall: true };
    assert.equal(Ln.chooseFormat(single, 'new', all), 'choice');
    assert.equal(Ln.chooseFormat(single, 'learning', all), 'choice');
    assert.equal(Ln.chooseFormat(single, 'familiar', all), 'written');
    assert.equal(Ln.chooseFormat(vague, 'familiar', all), 'recall');
    assert.equal(Ln.chooseFormat(single, 'familiar', { written: false, recall: true }), 'recall');
    assert.equal(Ln.chooseFormat(single, 'familiar', { written: false, recall: false }), 'choice');
    assert.equal(Ln.chooseFormat(multi, 'familiar', all), 'choice');
});

test('normalizeLearnState rejects rounds whose questions are gone', () => {
    const good = { v: Ln.STATE_VERSION, queue: ['q_1', 'q_2'], roundIds: ['q_1', 'q_2'], index: 9, results: {} };
    assert.equal(Ln.normalizeLearnState(good, ids).index, 2);
    assert.equal(Ln.normalizeLearnState(Object.assign({}, good, { queue: ['q_gone'] }), ids), null);
    for (const bad of [null, {}, { v: 99 }, Object.assign({}, good, { queue: [] })]) {
        assert.equal(Ln.normalizeLearnState(bad, ids), null);
    }
});

test('summarizeRound counts first-try and retried questions', () => {
    const r = Ln.summarizeRound(['a', 'b', 'c'], { a: { misses: 0, done: true }, b: { misses: 2, done: true }, c: { misses: 1, done: false } });
    assert.deepEqual(r, { total: 3, firstTry: 1, retried: 2 });
});
