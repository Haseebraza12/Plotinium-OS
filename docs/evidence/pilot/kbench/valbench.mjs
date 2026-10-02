import { build } from 'esbuild'; import zlib from 'node:zlib'; import fs from 'node:fs';
const libs = { zod: 'zod.js', 'zod-mini': 'zodmini.js', valibot: 'valibot.js', arktype: 'arktype.js', 'typebox-compile': 'typebox.js', 'typebox-value': 'typebox_value.js' };
const good = [{ id: 1, call: 'stat', args: { path: '/home/ali/docs/report.md' } }, { id: 2, call: 'chmod', args: { path: '/home/ali/x', mode: 'o-w', recursive: true } }, { id: 3, call: 'spawn', args: { image: '/bin/grep', argv: ['-r', 'todo', '.'] } }, { id: 4, call: 'kill', args: { pid: 42, signal: 'KILL' } }];
const bad = [{ id: -1, call: 'stat', args: { path: '' } }, { id: 2, call: 'chmod', args: { path: '/x', mode: 'rm -rf /' } }, { id: 3, call: 'eval', args: {} }, { id: 4, call: 'kill', args: { pid: '42; reboot' } }];
const out = {};
for (const [name, file] of Object.entries(libs)) {
  const r = await build({ stdin: { contents: `import { validate } from './val/${file}'; globalThis.v = validate;`, resolveDir: process.cwd() }, bundle: true, minify: true, format: 'esm', write: false, platform: 'browser' });
  const code = r.outputFiles[0].contents; const gz = zlib.gzipSync(code, { level: 9 }).length;
  const src = Buffer.from(code).toString(); const usesFn = /new Function\(|Function\(/.test(src);
  const { validate } = await import(`./val/${file}`);
  for (const m of good) if (!validate(m)) throw new Error(name + ' rejected good ' + JSON.stringify(m));
  for (const m of bad) if (validate(m)) throw new Error(name + ' accepted bad ' + JSON.stringify(m));
  const N = 300000; for (let i = 0; i < 50000; i++) validate(good[i & 3]);
  let t = performance.now(); for (let i = 0; i < N; i++) validate(good[i & 3]); const okNs = (performance.now() - t) * 1e6 / N;
  t = performance.now(); for (let i = 0; i < N; i++) validate(bad[i & 3]); const badNs = (performance.now() - t) * 1e6 / N;
  out[name] = { min_bytes: code.length, gzip_bytes: gz, valid_ns: +okNs.toFixed(0), invalid_ns: +badNs.toFixed(0), bundleContainsFunctionCtor: usesFn };
}
for (const [name, file] of Object.entries({ zod: 'zod.js', 'zod-mini': 'zodmini.js', valibot: 'valibot_json.js', arktype: 'arktype.js', typebox: 'typebox_json.js' })) {
  try { const { toJSON } = await import(`./val/${file}`); const j = toJSON(); const s = JSON.stringify(j); out[name] = { ...(out[name] || {}), jsonSchemaOk: true, jsonSchemaBytes: s.length, hasAnyOfOrOneOf: /anyOf|oneOf/.test(s), hasPattern: /pattern/.test(s) }; } catch (e) { out[name] = { ...(out[name] || {}), jsonSchemaOk: false, jsonSchemaErr: String(e).slice(0, 200) }; }
}
console.log(JSON.stringify(out, null, 1));
