// Run with: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../js/modes/matching.js');

const Q = (id, text, answer, choices) => ({ id, text, answer, choices: choices || { A: 'Paris', B: 'Rome', C: 'True', D: 'False' } });
const questions = [
    Q('q_1', 'Capital of France?', ['A']),
    Q('q_2', 'Capital of Italy?', ['B']),
    Q('q_3', 'The sky is blue.', ['C']),
    Q('q_4', 'Water is dry.', ['D']),
    Q('q_5', 'Grass is green.', ['C']),               // same answer text as q_3: "True"
    Q('q_6', 'Pick all.', ['A'], { A: 'All of the above', B: 'x' }), // vague: excluded
    Q('q_7', 'capital of FRANCE?', ['A']),             // repeated prompt: excluded
    Q('q_8', 'Two evens', ['A', 'C'], { A: '2', B: '3', C: '4' }),
];

test('pairable keeps specific answers, joins multi-answers, drops vague and repeated prompts', () => {
    const p = M.pairable(questions);
    assert.deepEqual(p.map((x) => x.id), ['q_1', 'q_2', 'q_3', 'q_4', 'q_5', 'q_8']);
    assert.equal(p.find((x) => x.id === 'q_8').answer, '2; 4');
    assert.equal(M.answerText({ choices: { A: 'x'.repeat(200) }, answer: ['A'] }), null);
});

test('questions with a code snippet are not used for matching', () => {
    const p = M.pairable([Q('q_c', 'What does this print?', ['A'], { A: '4', B: '6' })].map((q) => Object.assign(q, { code: 'Console.WriteLine(4);' })));
    assert.equal(p.length, 0);
});

test('buildRound shuffles both columns and keeps every pair', () => {
    let seed = 3;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const round = M.buildRound(M.pairable(questions), 4, rng);
    assert.equal(round.pairs.length, 4);
    assert.deepEqual(round.left.slice().sort(), round.pairs.map((p) => p.id).sort());
    assert.deepEqual(round.right.map((t) => t.pairId).sort(), round.pairs.map((p) => p.id).sort());
});

function fixedRound(ids) {
    const pairs = M.pairable(questions).filter((p) => ids.includes(p.id));
    return { pairs, left: pairs.map((p) => p.id), right: pairs.map((p) => ({ tileId: 't_' + p.id, pairId: p.id, text: p.answer })) };
}

test('identical answer texts are interchangeable, so a round can always be finished', () => {
    const round = fixedRound(['q_3', 'q_5']); // both "True"
    let g = M.newGame();
    // Match q_3 with q_5's tile: allowed, because the text is identical.
    let r = M.attempt(round, g, 'q_3', 't_q_5');
    assert.equal(r.ok, true);
    r = M.attempt(round, r.game, 'q_5', 't_q_3');
    assert.equal(r.ok, true);
    assert.equal(M.isComplete(round, r.game), true);
});

test('a wrong pick only counts a miss and never undoes a match', () => {
    const round = fixedRound(['q_1', 'q_2', 'q_4']);
    let r = M.attempt(round, M.newGame(), 'q_1', 't_q_1');
    r = M.attempt(round, r.game, 'q_2', 't_q_4');
    assert.equal(r.ok, false);
    assert.deepEqual(r.game.matched, { q_1: 't_q_1' });
    assert.deepEqual(r.game.misses, { q_2: 1 });
    // matched questions and used tiles can't be picked again
    assert.equal(M.attempt(round, r.game, 'q_1', 't_q_2').ignored, true);
    assert.equal(M.attempt(round, r.game, 'q_2', 't_q_1').ignored, true);
    r = M.attempt(round, r.game, 'q_2', 't_q_2');
    r = M.attempt(round, r.game, 'q_4', 't_q_4');
    assert.equal(M.isComplete(round, r.game), true);
    assert.equal(M.accuracy(r.game), 75);
    assert.deepEqual(M.outcomes(round, r.game), [
        { questionId: 'q_1', outcome: 'correct' },
        { questionId: 'q_2', outcome: 'incorrect' },
        { questionId: 'q_4', outcome: 'correct' },
    ]);
});

test('records keep the best time for timed rounds only, and best accuracy for both', () => {
    let { records, newBestTime } = M.updateRecords({}, { size: 6, timed: true, ms: 30000, accuracy: 80 });
    assert.equal(newBestTime, true);
    ({ records, newBestTime } = M.updateRecords(records, { size: 6, timed: true, ms: 40000, accuracy: 100 }));
    assert.equal(newBestTime, false);
    assert.equal(records['6'].bestMs, 30000);
    assert.equal(records['6'].bestAccuracy, 100);
    ({ records, newBestTime } = M.updateRecords(records, { size: 6, timed: false, ms: 1000, accuracy: 50 }));
    assert.equal(newBestTime, false);
    assert.equal(records['6'].bestMs, 30000); // relaxed rounds never set a time
    assert.equal(records['6'].plays, 3);
});

test('formatMs', () => {
    assert.equal(M.formatMs(65400), '1:05.4');
    assert.equal(M.formatMs(9050), '0:09.1');
});
