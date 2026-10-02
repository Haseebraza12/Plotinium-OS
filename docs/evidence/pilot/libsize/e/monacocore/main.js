import * as monaco from 'monaco-editor/editor/editor.api'; import editorWorker from 'monaco-editor/editor/editor.worker?worker';
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
const DOC = Array.from({ length: 5000 }, (_, i) => 'line ' + i + ' lorem ipsum dolor sit amet consectetur').join('\n');
monaco.editor.create(document.getElementById('x'), { value: DOC, language: 'markdown' }); setTimeout(() => { window.__ready = true; }, 500);
