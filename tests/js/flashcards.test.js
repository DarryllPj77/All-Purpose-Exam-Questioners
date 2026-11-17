// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../js/modes/flashcards.js');

const ids = ['q_a', 'q_b', 'q_c', 'q_d'];

test('reconcileOrder keeps saved order, drops removed ids, appends new ones', () => {
    assert.deepEqual(D.reconcileOrder(['q_c', 'q_x', 'q_a'], ids), ['q_c', 'q_a', 'q_b', 'q_d']);
    assert.deepEqual(D.reconcileOrder(undefined, ids), ids);
    assert.deepEqual(D.reconcileOrder(['q_a', 'q_a'], ['q_a']), ['q_a']);
});

test('shuffleOrder keeps every card and puts the current one first', () => {
    let seed = 7;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const out = D.shuffleOrder(ids, rng, 'q_c');
    assert.equal(out[0], 'q_c');
    assert.deepEqual(out.slice().sort(), ids.slice().sort());
    assert.deepEqual(ids, ['q_a', 'q_b', 'q_c', 'q_d'], 'input not mutated');
});

test('filterOrder by label, keeping deck order', () => {
    const statuses = { q_a: 'know', q_c: 'learning', q_d: 'know' };
    assert.deepEqual(D.filterOrder(ids, statuses, 'all'), ids);
    assert.deepEqual(D.filterOrder(ids, statuses, 'know'), ['q_a', 'q_d']);
    assert.deepEqual(D.filterOrder(ids, statuses, 'learning'), ['q_c']);
    assert.deepEqual(D.filterOrder(ids, statuses, 'unmarked'), ['q_b']);
    assert.deepEqual(D.filterOrder(ids, { q_a: 'bogus' }, 'unmarked'), ids);
});

test('step never wraps or skips', () => {
    assert.equal(D.step(0, -1, 4), 0);
    assert.equal(D.step(0, 1, 4), 1);
    assert.equal(D.step(3, 1, 4), 3);
    assert.equal(D.step(2, 1, 0), 0);
});

test('countDeck reports labels and viewed cards', () => {
    const c = D.countDeck(ids, { q_a: 'know', q_b: 'learning' }, new Set(['q_a', 'q_zzz']));
    assert.deepEqual(c, { all: 4, know: 1, learning: 1, unmarked: 2, viewed: 1 });
});

test('cardBack lists every correct answer with its explanation', () => {
    const back = D.cardBack({
        choices: { A: 'two', B: 'three', C: 'four' },
        answer: ['A', 'C'],
        answerDescriptions: { A: 'Even.', C: 'Also even.' },
    });
    assert.deepEqual(back, [
        { key: 'A', text: 'two', explanation: 'Even.' },
        { key: 'C', text: 'four', explanation: 'Also even.' },
    ]);
    assert.deepEqual(D.cardBack({ choices: { A: 'x' }, answer: 'A' }), [{ key: 'A', text: 'x', explanation: '' }]);
});

test('normalizeState survives corrupt or stale saved sessions', () => {
    for (const bad of [null, 'oops', [], { order: 'x', filter: 9, viewed: 'y', currentId: {} }]) {
        const st = D.normalizeState(bad, ids);
        assert.deepEqual(st.order, ids);
        assert.equal(st.filter, 'all');
        assert.equal(st.currentId, 'q_a');
        assert.deepEqual(st.viewed, []);
        assert.equal(st.shuffled, false);
    }
    const stale = D.normalizeState(
        { order: ['q_d', 'q_gone'], filter: 'know', currentId: 'q_gone', viewed: ['q_d', 'q_gone', 'q_d'], shuffled: true },
        ids);
    assert.deepEqual(stale.order, ['q_d', 'q_a', 'q_b', 'q_c']);
    assert.equal(stale.filter, 'know');
    assert.equal(stale.currentId, 'q_d');
    assert.deepEqual(stale.viewed, ['q_d']);
    assert.equal(stale.shuffled, true);
});

test('empty set gives an empty, valid state', () => {
    const st = D.normalizeState({ order: ['q_a'] }, []);
    assert.deepEqual(st.order, []);
    assert.equal(st.currentId, null);
});
