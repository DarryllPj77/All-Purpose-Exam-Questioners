// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../js/modes/recall.js');

const ids = ['q_1', 'q_2', 'q_3', 'q_4', 'q_5', 'q_6'];
const recall = {
    q_1: { rating: 'correct', updatedAt: '2026-11-10T00:00:00Z' },
    q_2: { rating: 'incorrect', updatedAt: '2026-11-15T00:00:00Z' },
    q_3: { rating: 'partial', updatedAt: '2026-11-12T00:00:00Z' },
    q_5: { rating: 'incorrect', updatedAt: '2026-11-11T00:00:00Z' },
    q_6: { rating: 'bogus' },
};

test('priorityOrder: hardest first, oldest first within a group', () => {
    assert.deepEqual(R.priorityOrder(ids, recall), ['q_5', 'q_2', 'q_3', 'q_4', 'q_6', 'q_1']);
});

test('ratingCounts treats unknown ratings as not yet tried', () => {
    assert.deepEqual(R.ratingCounts(ids, recall), { incorrect: 2, partial: 1, unseen: 2, correct: 1 });
});

test('normalizeRecallState drops stale ids and bad ratings', () => {
    const good = { v: R.STATE_VERSION, queue: ['q_1', 'q_2'], index: 7, results: { q_1: 'correct', q_9: 'correct', q_2: 'great' } };
    const st = R.normalizeRecallState(good, ids);
    assert.equal(st.index, 2);
    assert.deepEqual(st.results, { q_1: 'correct' });
    assert.equal(R.normalizeRecallState(Object.assign({}, good, { queue: ['q_gone'] }), ids), null);
    for (const bad of [null, {}, { v: 2 }, Object.assign({}, good, { queue: [] })]) {
        assert.equal(R.normalizeRecallState(bad, ids), null);
    }
});

test('summarize counts ratings and what to revisit', () => {
    assert.deepEqual(R.summarize({ a: 'correct', b: 'partial', c: 'incorrect', d: 'correct' }),
        { incorrect: 1, partial: 1, correct: 2, total: 4, revisit: 2 });
});
