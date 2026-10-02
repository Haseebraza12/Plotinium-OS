import { EditorView, keymap, lineNumbers } from '@codemirror/view'; import { EditorState } from '@codemirror/state'; import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
new EditorView({ state: EditorState.create({ doc: '# hi', extensions: [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap])] }), parent: document.getElementById('x') });
