// condash dashboard — bundle entry point.
//
// Until the frontend-split steps F3/F4 move code out of dashboard.html's
// inline <script> blocks, this entry is intentionally empty. esbuild still
// produces dist/bundle.js from it so the build pipeline, packaging, and
// static-serving route are exercised end-to-end from F1 onward.
//
// F3/F4 will add `import` statements for each region module here
// (theme, tabs, cards, search, notes-tree, config-modal, new-item-modal,
// sse-reloader, terminals, runners, markdown-preview, yaml-editor).

export {};
