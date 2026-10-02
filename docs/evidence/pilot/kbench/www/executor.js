self.onmessage = (e) => { if (e.data === 'spin') { for (;;) {} } };
self.postMessage('ready');
