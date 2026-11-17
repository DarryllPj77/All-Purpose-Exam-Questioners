/* ============================================================
   App shell: sidebar navigation, header title, question navigator.
   Wraps the existing functions (each wrapper calls the original
   first), so answer selection, scoring and saving are unchanged.
   ============================================================ */

function isExamVisible() {
    const exam = document.getElementById('examContainer');
    return !!exam && exam.style.display !== 'none';
}

const MODE_VIEWS = [
    { key: 'flashcards', label: 'Flashcards' },
    { key: 'practice', label: 'Practice test' },
];

/** The study-mode view that is open, as { key, label, ctl }, or null. */
function openModeView() {
    if (!window.Quizer) return null;
    for (const view of MODE_VIEWS) {
        const ctl = Quizer[view.key];
        if (ctl && ctl.isOpen()) return Object.assign({ ctl }, view);
    }
    return null;
}

function isFlashcardsOpen() {
    return !!(window.Quizer && Quizer.flashcards && Quizer.flashcards.isOpen());
}

function isResultsVisible() {
    const results = document.getElementById('results');
    return !!results && results.style.display !== 'none' && isExamVisible();
}

function activeQuestionSetTitle() {
    try {
        const id = QSetStore.getActiveId();
        const summary = id ? QSetStore.list().find((set) => set.id === id) : null;
        if (summary && summary.title) return summary.title;
    } catch (_) { /* store not ready */ }
    return 'Default question set';
}

// ---- Header title follows the current screen ---------------------------
function syncAppBar() {
    const eyebrow = document.getElementById('appBarEyebrow');
    const title = document.getElementById('appBarTitle');
    if (!eyebrow || !title) return;
    const modeView = openModeView();
    if (modeView) {
        eyebrow.textContent = modeView.label;
        title.textContent = modeView.ctl.title() || activeQuestionSetTitle();
    } else if (isResultsVisible()) {
        eyebrow.textContent = isTrainingMode ? 'Training results' : 'Exam results';
        title.textContent = activeQuestionSetTitle();
    } else if (isExamVisible()) {
        eyebrow.textContent = isTrainingMode ? 'Training session' : 'Exam session';
        title.textContent = activeQuestionSetTitle();
    } else {
        eyebrow.textContent = 'Workspace';
        title.textContent = 'Dashboard';
    }
    const setTitle = document.getElementById('quizSetTitle');
    if (setTitle) setTitle.textContent = activeQuestionSetTitle();
    document.body.classList.toggle('is-quiz', isExamVisible() && !isResultsVisible());
}

// ---- Question navigator -----------------------------------------------
function isQuestionAnswered(index) {
    const answer = userAnswers[index];
    return Array.isArray(answer) ? answer.length > 0 : !!answer;
}

function renderQuestionNavigator() {
    const nav = document.getElementById('questionNav');
    if (!nav || typeof questions === 'undefined') return;
    nav.setAttribute('role', 'group');
    const total = questions.length;
    let answered = 0;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
        const isAnswered = isQuestionAnswered(i);
        const isCurrent = i === currentQuestion;
        if (isAnswered) answered++;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'qn-btn' +
            (isAnswered ? ' qn-btn--answered' : '') +
            (isCurrent ? ' qn-btn--current' : '');
        button.textContent = String(i + 1);
        button.setAttribute('aria-label',
            `Question ${i + 1}, ${isAnswered ? 'answered' : 'not answered'}${isCurrent ? ', current' : ''}`);
        if (isCurrent) button.setAttribute('aria-current', 'step');
        button.addEventListener('click', () => goToQuestion(i));
        fragment.appendChild(button);
    }
    nav.replaceChildren(fragment);

    const count = document.getElementById('navigatorCount');
    if (count) count.textContent = `${Math.min(currentQuestion + 1, total)} / ${total}`;
    const summary = document.getElementById('navigatorSummary');
    if (summary) {
        const left = total - answered;
        summary.textContent = left
            ? `${answered} of ${total} answered · ${left} left`
            : `All ${total} questions answered`;
    }
}

function goToQuestion(index) {
    if (typeof questions === 'undefined' || index < 0 || index >= questions.length) return;
    currentQuestion = index;
    displayQuestion();
    updateProgress();
    saveToStorage();
    const card = document.querySelector('.question-card');
    if (card && window.matchMedia('(max-width: 1100px)').matches) {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Submitting from the panel can happen before the last question, so it
// confirms when questions are still unanswered, then runs the normal submit.
function submitFromNavigator() {
    if (typeof questions === 'undefined') return;
    let unanswered = 0;
    for (let i = 0; i < questions.length; i++) if (!isQuestionAnswered(i)) unanswered++;
    if (unanswered > 0) {
        const ok = window.confirm(
            `${unanswered} question${unanswered === 1 ? ' is' : 's are'} still unanswered and will be marked incorrect. Submit anyway?`);
        if (!ok) return;
    }
    submitExam();
}

// ---- Sidebar ----------------------------------------------------------
function toggleSidebar(force) {
    const sidebar = document.getElementById('appSidebar');
    const scrim = document.getElementById('sidebarScrim');
    const toggle = document.getElementById('sidebarToggle');
    if (!sidebar) return;
    const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('is-open');
    sidebar.classList.toggle('is-open', open);
    document.body.classList.toggle('sidebar-open', open);
    if (scrim) scrim.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        const first = sidebar.querySelector('.side-nav__link');
        if (first) first.focus();
    } else if (toggle && sidebar.contains(document.activeElement)) {
        toggle.focus();
    }
}

function setActiveNav(target) {
    document.querySelectorAll('.side-nav__link[data-nav-target]').forEach((link) => {
        const active = link.dataset.navTarget === target;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
    });
}

function navigateToSection(target) {
    // Leaving a live session keeps it resumable (same as "Save and exit").
    if (isExamVisible()) backToDashboard();
    const modeView = openModeView();
    if (modeView) modeView.ctl.close();
    const feedback = document.getElementById('fullscreenFeedback');
    if (feedback && feedback.style.display !== 'none') closeFeedback();
    setActiveNav(target);
    toggleSidebar(false);
    const el = document.getElementById(target);
    if (!el) return;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (target === 'dashboard') window.scrollTo({ top: 0, behavior });
    else el.scrollIntoView({ behavior, block: 'start' });
}

function watchSectionsForNav() {
    if (!('IntersectionObserver' in window)) return;
    const ids = ['studyCard', 'generateCard', 'importCard', 'questionSetsSection', 'sessionHistory'];
    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0));
        if (isExamVisible() || openModeView()) return;
        if (window.scrollY < 80) { setActiveNav('dashboard'); return; }
        let best = null; let bestRatio = 0;
        ids.forEach((id) => { const r = visible.get(id) || 0; if (r > bestRatio) { best = id; bestRatio = r; } });
        if (best) setActiveNav(best);
    }, { threshold: [0, 0.25, 0.5, 0.75], rootMargin: '-70px 0px -35% 0px' });
    ids.forEach((id) => { const el = document.getElementById(id); if (el) observer.observe(el); });
}

// ---- Wrap existing screen changes ---------------------------------------
(function wrapScreenChanges() {
    const wrap = (name, after) => {
        const original = window[name];
        if (typeof original !== 'function') return;
        window[name] = function () {
            const result = original.apply(this, arguments);
            after();
            return result;
        };
    };
    const refreshQuiz = () => { renderQuestionNavigator(); syncAppBar(); setActiveNav('studyCard'); };
    wrap('displayQuestion', refreshQuiz);
    wrap('selectAnswer', renderQuestionNavigator);
    wrap('showResults', () => { syncAppBar(); setActiveNav('studyCard'); window.scrollTo({ top: 0 }); });
    wrap('backToDashboard', () => { syncAppBar(); setActiveNav('dashboard'); });
    wrap('showFullscreenFeedback', syncAppBar);
    wrap('closeFeedback', syncAppBar);
})();

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.side-nav__link[data-nav-target]:not([data-open-view])').forEach((link) => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            navigateToSection(link.dataset.navTarget);
        });
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) toggleSidebar(false);
    });
    window.matchMedia('(min-width: 1025px)').addEventListener('change', (mq) => {
        if (mq.matches) toggleSidebar(false);
    });
    watchSectionsForNav();
    syncAppBar();
});
