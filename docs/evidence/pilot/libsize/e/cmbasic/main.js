import { EditorView, basicSetup } from 'codemirror'; import { markdown } from '@codemirror/lang-markdown';
const DOC = Array.from({ length: 5000 }, (_, i) => 'line ' + i + ' lorem ipsum dolor sit amet consectetur').join('\n');
new EditorView({ doc: DOC, extensions: [basicSetup, markdown()], parent: document.getElementById('x') }); window.__ready = true;
