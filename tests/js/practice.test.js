// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../js/modes/practice.js');
const { isCorrectAnswer } = require('../../js/core/learning.js');

const Q = (id, answer, extra) => Object.assign({
    id, text: id, choices: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer, maxSelections: answer.length,
}, extra || {});
const questions = [Q('q_1', ['A']), Q('q_2', ['B']), Q('q_3', ['A', 'C']), Q('q_4', ['D']), Q('q_5', ['B', 'D'])];
const byId = new Map(questions.map((q) => [q.id, q]));
const base = { count: 5, types: ['single', 'multiple'], timerOn: false, passPercent: 70 };

test('question types: multiple when more than one answer', () => {
    assert.deepEqual(P.countTypes(questions), { single: 3, multiple: 2 });
});

test('validateConfig accepts good input and reports each bad field', () => {
    assert.deepEqual(P.validateConfig(base, questions).errors, {});
    const { errors } = P.validateConfig(
        { count: 0, types: [], timerOn: true, timerMinutes: 0, passPercent: 150 }, questions);
    assert.ok(errors.count && errors.types && errors.timerMinutes && errors.passPercent);
});

test('validateConfig caps the count to questions of the chosen types', () => {
    const { errors, available } = P.validateConfig(Object.assign({}, base, { count: 4, types: ['multiple'] }), questions);
    assert.equal(available, 2);
    assert.match(errors.count, /Only 2/);
});

test('buildTest respects count, types and keeps every choice', () => {
    const { config } = P.validateConfig(Object.assign({}, base, { count: 2, types: ['single'], shuffleAnswers: true }), questions);
    const items = P.buildTest(questions, config, () => 0.3);
    assert.equal(items.length, 2);
    for (const it of items) {
        assert.equal(P.questionType(byId.get(it.id)), 'single');
        assert.deepEqual(it.choiceOrder.slice().sort(), ['A', 'B', 'C', 'D']);
    }
});

test('unshuffled test keeps set order and original choice order', () => {
    const { config } = P.validateConfig(Object.assign({}, base, { shuffleQuestions: false }), questions);
    const items = P.buildTest(questions, config);
    assert.deepEqual(items.map((i) => i.id), ['q_1', 'q_2', 'q_3', 'q_4', 'q_5']);
    assert.deepEqual(items[0].choiceOrder, ['A', 'B', 'C', 'D']);
});

test('displayChoices relabels by position but keeps original keys', () => {
    const shown = P.displayChoices(byId.get('q_1'), ['C', 'A', 'D', 'B']);
    assert.deepEqual(shown.map((c) => c.label + c.key), ['AC', 'BA', 'CD', 'DB']);
});

test('scoreTest: correct, incorrect, unanswered and multi-answer', () => {
    const items = questions.map((q) => ({ id: q.id, choiceOrder: ['A', 'B', 'C', 'D'] }));
    const answers = { q_1: ['A'], q_2: ['C'], q_3: ['C', 'A'], q_5: ['B'] }; // q_4 unanswered, q_5 partial
    const r = P.scoreTest(items, answers, byId, 70, isCorrectAnswer);
    assert.equal(r.total, 5);
    assert.equal(r.correct, 2);
    assert.equal(r.incorrect, 2);
    assert.equal(r.unanswered, 1);
    assert.equal(r.percent, 40);
    assert.equal(r.passed, false);
    assert.deepEqual(r.perQuestion.map((x) => x.status), ['correct', 'incorrect', 'correct', 'unanswered', 'incorrect']);
});

test('pass mark uses the exact ratio, never a rounded percentage', () => {
    const many = Array.from({ length: 23 }, (_, i) => Q('q_' + i, ['A']));
    const map = new Map(many.map((q) => [q.id, q]));
    const items = many.map((q) => ({ id: q.id, choiceOrder: ['A', 'B', 'C', 'D'] }));
    const answers = {};
    many.slice(0, 16).forEach((q) => { answers[q.id] = ['A']; }); // 16/23 = 69.57% → shows 70%
    const r = P.scoreTest(items, answers, map, 70, isCorrectAnswer);
    assert.equal(r.percent, 70);
    assert.equal(r.passed, false);
    answers[many[16].id] = ['A']; // 17/23 = 73.9%
    assert.equal(P.scoreTest(items, answers, map, 70, isCorrectAnswer).passed, true);
});

test('the timer changes duration, never the score', () => {
    const start = 1_000_000;
    assert.equal(P.durationSeconds(start, start + 95_400, null), 95);
    assert.equal(P.durationSeconds(start, start + 999_999, start + 600_000), 600); // capped at the limit
    assert.equal(P.remainingSeconds(start + 60_000, start + 59_100), 1);
    assert.equal(P.remainingSeconds(start, start + 5_000), 0);
    assert.equal(P.remainingSeconds(null, start), null);
});

test('formatClock', () => {
    assert.equal(P.formatClock(65), '1:05');
    assert.equal(P.formatClock(3725), '1:02:05');
    assert.equal(P.formatClock(-3), '0:00');
});

test('toggleChoice: radio for one answer, capped checkboxes for several', () => {
    assert.deepEqual(P.toggleChoice(['A'], 'B', 1), ['B']);
    assert.deepEqual(P.toggleChoice(['A'], 'C', 2), ['A', 'C']);
    assert.deepEqual(P.toggleChoice(['A', 'C'], 'D', 2), ['A', 'C']);
    assert.deepEqual(P.toggleChoice(['A', 'C'], 'A', 2), ['C']);
});

test('normalizeRunState rejects tests whose questions changed', () => {
    const good = {
        v: P.STATE_VERSION, attemptId: 'p_abc12345', status: 'running', current: 9, maxReached: 0,
        items: [{ id: 'q_1', choiceOrder: ['A', 'B', 'C', 'D'] }, { id: 'q_2', choiceOrder: ['D', 'C', 'B', 'A'] }],
        answers: { q_1: ['A'], q_9: ['B'] }, checked: { q_1: true, q_zz: true },
    };
    const st = P.normalizeRunState(good, byId);
    assert.equal(st.current, 1);                  // clamped
    assert.deepEqual(Object.keys(st.answers), ['q_1']);
    assert.deepEqual(Object.keys(st.checked), ['q_1']);
    assert.equal(P.normalizeRunState(Object.assign({}, good, { items: [{ id: 'q_gone', choiceOrder: ['A'] }] }), byId), null);
    assert.equal(P.normalizeRunState(Object.assign({}, good, { items: [{ id: 'q_1', choiceOrder: ['A', 'B'] }] }), byId), null);
    for (const bad of [null, {}, { v: 99 }, Object.assign({}, good, { status: 'weird' })]) {
        assert.equal(P.normalizeRunState(bad, byId), null);
    }
});
