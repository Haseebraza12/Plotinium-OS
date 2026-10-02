import * as monaco from 'monaco-editor'; import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'; import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
self.MonacoEnvironment = { getWorker: (_, l) => (l === 'typescript' || l === 'javascript' ? new tsWorker() : new editorWorker()) };
monaco.editor.create(document.getElementById('x'), { value: 'let a = 1', language: 'javascript' });
