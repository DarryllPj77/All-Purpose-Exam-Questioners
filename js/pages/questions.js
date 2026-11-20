/* Page: Question library (/questions). Its markup is <section class="page" data-page="questions">
   in Index.html; js/router.js attaches it when this route is active. */
Quizer.router.register({
    name: 'questions',
    onEnter() {
        // Re-render from the cached library so changes made elsewhere show.
        if (typeof renderQuestionSets === 'function') renderQuestionSets();
    },
});
