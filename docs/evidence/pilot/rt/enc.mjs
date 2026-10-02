import { pack, unpack, Packr } from 'msgpackr';
const msg = { v:1, t:'vfs.changed', srvSeq: 918273, origin:'s_7f3a9c2e', opId:'01J9Z6X0B8K3QF2V7M4N5P6R7S', hlc:'0001727086400123:0007:c1a2', changes: Array.from({length: 5}, (_, i) => ({ ino: 100000+i, parent: 4242, name: `chapter-${i}.md`, kind:'update', version: 17+i, size: 4096*i, mode: 0o644, uid: 1001, mtime: 1727086400123 })) };
const small = { v:1, t:'lock.granted', reqId: 77, ino: 4242, mode:'X', leaseId:'L-5521', fence: 5521, expiresAt: 1727086430123 };
const packrStruct = new Packr({ useRecords: true });
for (const [name, m] of [['vfs.changed(5)', msg], ['lock.granted', small]]) {
  const j = Buffer.byteLength(JSON.stringify(m)); const p = pack(m).length; const ps = packrStruct.pack(m).length;
  const R = 200000; let t = performance.now(); for (let i=0;i<R;i++) JSON.parse(JSON.stringify(m)); const tj = (performance.now()-t)/R*1000;
  t = performance.now(); for (let i=0;i<R;i++) unpack(pack(m)); const tp = (performance.now()-t)/R*1000;
  console.log(name.padEnd(16), `json=${j}B msgpack=${p}B msgpack+records=${ps}B | roundtrip json=${tj.toFixed(2)}us msgpack=${tp.toFixed(2)}us`);
}
