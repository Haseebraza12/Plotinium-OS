const DOC = Array.from({ length: 5000 }, (_, i) => 'line ' + i + ' lorem ipsum dolor sit amet consectetur').join('\n');
const t = document.createElement('textarea'); t.value = DOC; t.style.cssText = 'width:600px;height:400px'; document.getElementById('x').append(t); window.__ready = true;
