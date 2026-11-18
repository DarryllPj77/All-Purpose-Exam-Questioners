/* ============================================================
   Matching mode.

   Pairs each question (left) with the text of its correct answer
   (right). Both columns are shuffled. Pick one side, then the other:
   every tile is a button, so mouse, touch and keyboard all work, and
   nothing depends on drag-and-drop.

   * Pairs are tracked by question id. A right tile whose text is the
     same as the correct answer also counts, so identical labels (two
     questions answered "True") can never make a round unwinnable.
   * A wrong pick only adds to the miss count; it never changes what is
     already matched.
   * Relaxed rounds have no clock. Timed rounds record a best time per
     round size; accuracy is tracked for both (study_sessions "matching").
   * Each pair is logged to the answer log (mode "matching"): correct if
     matched on the first try, otherwise incorrect.

   Top half: pure logic (exported for `node --test`).
   Bottom half: browser controller (window.Quizer.matching).
   ============================================================ */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api.logic;
    if (root) root.Quizer = Object.assign(root.Quizer || {}, { matching: api.controller });
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const core = (root && root.Quizer && root.Quizer.learning)
        || (typeof require === 'function' ? require('../core/learning.js') : null);
    const norm = (t) => core.normalizeText(t);
    const MAX_ANSWER_CHARS = 120;
    const VAGUE = /(of the above|^both\b|^neither\b|^all\b|^none\b)/;
    const SIZES = [4, 6, 8];

    // ---- Pure logic ------------------------------------------------------------

    function answerList(a) { return Array.isArray(a) ? a.map(String) : (a == null ? [] : [String(a)]); }

    /** The right-hand text for a question, or null when it can't make a fair pair. */
    function answerText(question) {
        const choices = (question && question.choices) || {};
        const keys = answerList(question && question.answer);
        if (!keys.length) return null;
        const parts = keys.map((k) => (typeof choices[k] === 'string' ? choices[k].trim() : ''));
        if (parts.some((p) => !p || VAGUE.test(norm(p)))) return null;
        const text = parts.join('; ');
        return text.length > MAX_ANSWER_CHARS ? null : text;
    }

    /** Questions that can be paired, without repeated prompts. */
    function pairable(questions) {
        const seen = new Set();
        const out = [];
        (questions || []).forEach((q) => {
            if (!q || !q.id || !q.text) return;
            // "What does this print?" means nothing without its code.
            if (typeof q.code === 'string' && q.code.trim()) return;
            const answer = answerText(q);
            const key = norm(q.text);
            if (!answer || !key || seen.has(key)) return;
            seen.add(key);
            out.push({ id: q.id, prompt: q.text.trim(), answer });
        });
        return out;
    }

    function shuffled(list, random) {
        const rng = typeof random === 'function' ? random : Math.random;
        const out = list.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    /** A round: `size` pairs, both columns shuffled independently. */
    function buildRound(pairs, size, random) {
        const chosen = shuffled(pairs, random).slice(0, Math.max(2, size | 0));
        return {
            pairs: chosen,
            left: shuffled(chosen.map((p) => p.id), random),
            right: shuffled(chosen.map((p) => ({ tileId: 't_' + p.id, pairId: p.id, text: p.answer })), random),
        };
    }

    /** Does this right tile answer that left question? (id, or identical text) */
    function isMatch(round, leftId, tileId) {
        const pair = round.pairs.find((p) => p.id === leftId);
        const tile = round.right.find((t) => t.tileId === tileId);
        if (!pair || !tile) return false;
        return tile.pairId === leftId || norm(tile.text) === norm(pair.answer);
    }

    function newGame() {
        return { matched: {}, usedTiles: {}, misses: {}, attempts: 0, correct: 0 };
    }

    /**
     * Apply one pick. Returns { game, ok }. Matched questions and used
     * tiles can't be picked again, and a miss only adds to the miss count.
     */
    function attempt(round, game, leftId, tileId) {
        if (game.matched[leftId] || game.usedTiles[tileId]) return { game, ok: false, ignored: true };
        const ok = isMatch(round, leftId, tileId);
        const next = {
            matched: Object.assign({}, game.matched),
            usedTiles: Object.assign({}, game.usedTiles),
            misses: Object.assign({}, game.misses),
            attempts: game.attempts + 1,
            correct: game.correct + (ok ? 1 : 0),
        };
        if (ok) {
            next.matched[leftId] = tileId;
            next.usedTiles[tileId] = leftId;
        } else {
            next.misses[leftId] = (next.misses[leftId] || 0) + 1;
        }
        return { game: next, ok };
    }

    function isComplete(round, game) {
        return round.pairs.every((p) => game.matched[p.id]);
    }

    function accuracy(game) {
        return game.attempts ? Math.round((game.correct / game.attempts) * 100) : 0;
    }

    /** Per-pair outcomes for the answer log: first-try matches are correct. */
    function outcomes(round, game) {
        return round.pairs.map((p) => ({ questionId: p.id, outcome: game.misses[p.id] ? 'incorrect' : 'correct' }));
    }

    /** Merge a finished round into saved records; returns { records, newBestTime }. */
    function updateRecords(records, result) {
        const all = Object.assign({}, records || {});
        const key = String(result.size);
        const prev = all[key] || {};
        const rec = Object.assign({}, prev, {
            plays: (prev.plays || 0) + 1,
            lastAccuracy: result.accuracy,
            bestAccuracy: Math.max(prev.bestAccuracy || 0, result.accuracy),
        });
        let newBestTime = false;
        if (result.timed && Number.isFinite(result.ms)) {
            if (!prev.bestMs || result.ms < prev.bestMs) { rec.bestMs = result.ms; newBestTime = true; }
        }
        all[key] = rec;
        return { records: all, newBestTime };
    }

    function formatMs(ms) {
        const total = Math.max(0, Math.round(ms / 100)) / 10;
        const m = Math.floor(total / 60);
        const s = (total - m * 60).toFixed(1).padStart(4, '0');
        return `${m}:${s}`;
    }

    const logic = { answerText, pairable, buildRound, isMatch, newGame, attempt, isComplete, accuracy, outcomes, updateRecords, formatMs, SIZES };

    // ---- Browser controller ----------------------------------------------------

    if (!root || typeof root.document === 'undefined') return { logic, controller: null };
    const doc = root.document;
    const L = () => root.Quizer.learning;
    const $ = (id) => doc.getElementById(id);
    const MODE = 'matching';

    function activeSetId() {
        // eslint-disable-next-line no-undef
        return (typeof QSetStore !== 'undefined' && QSetStore) ? QSetStore.getActiveId() : null;
    }

    const s = {
        open: false, setId: null, title: '', pairs: [], records: {},
        size: 6, timed: false,
        round: null, game: null, pick: null, // pick: { side: 'left'|'right', id }
        startedAt: 0, clock: null, busy: false,
    };

    function announce(t) { const el = $('mtLive'); if (el) el.textContent = t; }
    function syncShell() {
        if (typeof root.syncAppBar === 'function') root.syncAppBar();
        if (s.open && typeof root.setActiveNav === 'function') root.setActiveNav('matchView');
    }
    function showScreen(name) {
        ['mtIntro', 'mtBoard', 'mtDone'].forEach((id) => { $(id).hidden = id !== name; });
        $('mtState').hidden = true;
    }
    function showState(kind, message, action) {
        ['mtIntro', 'mtBoard', 'mtDone'].forEach((id) => { $(id).hidden = true; });
        const box = $('mtState');
        box.hidden = false;
        box.className = 'ui-state ui-state--' + (kind === 'error' ? 'error' : kind === 'loading' ? 'loading' : 'empty');
        box.replaceChildren();
        if (kind === 'loading') {
            const spin = doc.createElement('span');
            spin.className = 'ui-spinner';
            spin.setAttribute('aria-hidden', 'true');
            box.appendChild(spin);
        }
        const text = doc.createElement('span');
        text.textContent = message;
        box.appendChild(text);
        if (action) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn--secondary btn--sm';
            btn.textContent = action.label;
            btn.addEventListener('click', action.run);
            box.appendChild(btn);
        }
    }

    // ================= Intro =================
    function renderIntro() {
        showScreen('mtIntro');
        const max = s.pairs.length;
        doc.querySelectorAll('input[name="mtSize"]').forEach((r) => {
            const n = parseInt(r.value, 10);
            r.disabled = n > max;
            r.checked = n === s.size;
            const rec = s.records[String(n)];
            const note = $('mtBest_' + n);
            if (note) {
                note.textContent = n > max ? `needs ${n} pairable questions`
                    : rec && rec.bestMs ? `best ${formatMs(rec.bestMs)}`
                        : rec ? `best accuracy ${rec.bestAccuracy}%` : 'not played yet';
            }
        });
        if (!doc.querySelector('input[name="mtSize"]:checked')) {
            const first = doc.querySelector('input[name="mtSize"]:not(:disabled)');
            if (first) { first.checked = true; s.size = parseInt(first.value, 10); }
        }
        doc.querySelector(`input[name="mtMode"][value="${s.timed ? 'timed' : 'relaxed'}"]`).checked = true;
        $('mtPairCount').textContent = `${max} of this set's questions can be paired.`;
        $('mtStart').disabled = max < 2;
    }

    function start() {
        const chosen = doc.querySelector('input[name="mtSize"]:checked');
        s.size = chosen ? parseInt(chosen.value, 10) : Math.min(6, s.pairs.length);
        s.timed = doc.querySelector('input[name="mtMode"]:checked').value === 'timed';
        s.round = buildRound(s.pairs, Math.min(s.size, s.pairs.length), Math.random);
        s.game = newGame();
        s.pick = null;
        s.startedAt = Date.now();
        showScreen('mtBoard');
        renderBoard();
        startClock();
        const first = $('mtLeft').querySelector('button:not(:disabled)');
        if (first) first.focus();
        announce(`Round started. ${s.round.pairs.length} pairs. Pick a question, then its answer.`);
    }

    // ================= Board =================
    function tileButton(side, id, text, state) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'mt-tile mt-tile--' + side + (state.matched ? ' is-matched' : '') + (state.picked ? ' is-picked' : '');
        b.dataset.side = side;
        b.dataset.id = id;
        b.disabled = !!state.matched;
        b.setAttribute('aria-pressed', state.picked ? 'true' : 'false');
        const label = doc.createElement('span');
        label.className = 'mt-tile__text';
        label.textContent = text;
        b.appendChild(label);
        if (state.matched) {
            const tick = doc.createElement('span');
            tick.className = 'mt-tile__tick';
            tick.setAttribute('aria-hidden', 'true');
            tick.textContent = '✓';
            b.appendChild(tick);
            b.setAttribute('aria-label', `${text}, matched`);
        }
        b.addEventListener('click', () => pick(side, id));
        return b;
    }

    function renderBoard() {
        const { round, game } = s;
        const byId = new Map(round.pairs.map((p) => [p.id, p]));
        const left = $('mtLeft');
        left.replaceChildren();
        round.left.forEach((id) => {
            left.appendChild(tileButton('left', id, byId.get(id).prompt, {
                matched: !!game.matched[id],
                picked: s.pick && s.pick.side === 'left' && s.pick.id === id,
            }));
        });
        const right = $('mtRight');
        right.replaceChildren();
        round.right.forEach((t) => {
            right.appendChild(tileButton('right', t.tileId, t.text, {
                matched: !!game.usedTiles[t.tileId],
                picked: s.pick && s.pick.side === 'right' && s.pick.id === t.tileId,
            }));
        });
        const done = Object.keys(game.matched).length;
        $('mtProgress').textContent = `${done} of ${round.pairs.length} matched`;
        const pct = Math.round((done / round.pairs.length) * 100);
        $('mtFill').style.width = pct + '%';
        $('mtFill').parentElement.setAttribute('aria-valuenow', String(pct));
        const misses = game.attempts - game.correct;
        $('mtMisses').textContent = `${misses} miss${misses === 1 ? '' : 'es'}`;
        $('mtClockWrap').hidden = !s.timed;
    }

    function pick(side, id) {
        if (!s.round || s.busy) return;
        if (!s.pick || s.pick.side === side) {
            // First pick, or switching the pick on the same side.
            s.pick = (s.pick && s.pick.side === side && s.pick.id === id) ? null : { side, id };
            renderBoard();
            refocus(side, id);
            if (s.pick) announce(side === 'left' ? 'Question selected. Now pick its answer.' : 'Answer selected. Now pick its question.');
            return;
        }
        const leftId = side === 'left' ? id : s.pick.id;
        const tileId = side === 'right' ? id : s.pick.id;
        const res = attempt(s.round, s.game, leftId, tileId);
        if (res.ignored) return;
        s.game = res.game;
        s.pick = null;
        if (res.ok) {
            renderBoard();
            announce(`Matched. ${Object.keys(s.game.matched).length} of ${s.round.pairs.length}.`);
            if (isComplete(s.round, s.game)) { finish(); return; }
            const nextLeft = $('mtLeft').querySelector('button:not(:disabled)');
            if (nextLeft) nextLeft.focus();
        } else {
            // Show the miss on both tiles briefly; nothing else changes.
            s.busy = true;
            renderBoard();
            [['left', leftId], ['right', tileId]].forEach(([sd, i]) => {
                const el = $(sd === 'left' ? 'mtLeft' : 'mtRight').querySelector(`[data-id="${CSS.escape(i)}"]`);
                if (el) el.classList.add('is-wrong');
            });
            announce('Not a match. Try again.');
            setTimeout(() => {
                s.busy = false;
                renderBoard();
                refocus(side, id);
            }, 650);
        }
    }

    function refocus(side, id) {
        const el = $(side === 'left' ? 'mtLeft' : 'mtRight').querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (el && !el.disabled) el.focus();
    }

    function startClock() {
        clearInterval(s.clock);
        if (!s.timed) return;
        const tick = () => { $('mtClock').textContent = formatMs(Date.now() - s.startedAt); };
        tick();
        s.clock = setInterval(tick, 100);
    }

    // ================= Done =================
    async function finish() {
        clearInterval(s.clock);
        const ms = Date.now() - s.startedAt;
        const acc = accuracy(s.game);
        const result = { size: s.round.pairs.length, timed: s.timed, ms, accuracy: acc };
        const upd = updateRecords(s.records, result);
        s.records = upd.records;
        showScreen('mtDone');
        $('mtDoneTime').textContent = s.timed ? formatMs(ms) : '—';
        $('mtDoneTimeNote').textContent = s.timed ? (upd.newBestTime ? 'New best time' : `Best ${formatMs(s.records[String(result.size)].bestMs)}`) : 'Relaxed round';
        $('mtDoneAccuracy').textContent = acc + '%';
        $('mtDoneMisses').textContent = String(s.game.attempts - s.game.correct);
        $('mtDoneText').textContent = `All ${result.size} pairs matched` + (s.timed ? ` in ${formatMs(ms)}.` : '.')
            + (upd.newBestTime ? ' That is your best time for this round size.' : '');
        $('mtDoneHeading').focus();
        announce('Round complete.');

        // Save records and log each pair (first-try match = correct).
        const attemptId = L().newClientId('m');
        try {
            await Promise.all([
                L().api.saveSession(s.setId, MODE, { v: 1, records: s.records, size: s.size, timed: s.timed }),
                L().api.recordAttempts(s.setId, outcomes(s.round, s.game).map((o, i) => ({
                    questionId: o.questionId, mode: MODE, outcome: o.outcome, clientAttemptId: `${attemptId}_${i}`,
                }))),
            ]);
        } catch (e) {
            console.warn('[matching] could not save the round:', e.message);
        }
        s.round = null;
    }

    // ================= Open / close =================
    async function open() {
        if (typeof root.closeModeViews === 'function') root.closeModeViews('matching');
        s.open = true;
        root.showModeView('matchView');
        if (typeof root.toggleSidebar === 'function') root.toggleSidebar(false);
        root.scrollTo({ top: 0 });
        syncShell();
        const setId = activeSetId();
        if (!setId) {
            s.setId = null;
            $('mtTitle').textContent = 'Matching';
            showState('empty', 'Choose a question set first. Matching uses your active set.',
                { label: 'Go to question library', run: () => { close(); root.navigateToSection && root.navigateToSection('questionSetsSection'); } });
            return;
        }
        showState('loading', 'Loading matching…');
        try {
            const [set, saved] = await Promise.all([
                L().api.getSet(setId),
                L().api.loadSession(setId, MODE).catch(() => null),
            ]);
            if (!s.open) return;
            s.setId = setId;
            s.title = set.title || 'Question set';
            s.pairs = pairable(set.questions || []);
            s.records = (saved && saved.records && typeof saved.records === 'object') ? saved.records : {};
            if (saved && SIZES.includes(saved.size)) s.size = saved.size;
            if (saved && typeof saved.timed === 'boolean') s.timed = saved.timed;
            $('mtTitle').textContent = s.title;
            syncShell();
            if (s.pairs.length < 2) {
                showState('empty', 'This set needs at least 2 questions with a short, specific answer to play Matching.');
                return;
            }
            renderIntro();
        } catch (e) {
            if (!s.open) return;
            showState('error', 'Could not load Matching. ' + e.message, { label: 'Try again', run: open });
        }
    }

    function close() {
        if (!s.open) return;
        clearInterval(s.clock);
        s.open = false;
        s.round = null;
        root.showModeView(null);
        syncShell();
        if (typeof root.setActiveNav === 'function') root.setActiveNav('dashboard');
    }

    // -- input --
    function bind() {
        if (!$('matchView')) return;
        $('mtStart').addEventListener('click', start);
        $('mtAgain').addEventListener('click', start);
        $('mtSettings').addEventListener('click', renderIntro);
        $('mtQuit').addEventListener('click', () => { clearInterval(s.clock); s.round = null; renderIntro(); announce('Round stopped.'); });
        $('mtDoneExit').addEventListener('click', close);
        $('mtExit').addEventListener('click', close);
        doc.querySelectorAll('[data-open-view="matching"]').forEach((el) => {
            el.addEventListener('click', (e) => { e.preventDefault(); open(); });
        });
        doc.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && s.open && s.pick) { s.pick = null; renderBoard(); announce('Selection cleared.'); }
        });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind);
    else bind();

    const controller = { open, close, isOpen: () => s.open, title: () => s.title };
    return { logic, controller };
});
