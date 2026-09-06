const v9css = document.createElement('link');
v9css.rel = 'stylesheet';
v9css.href = '/v9.css';
document.head.appendChild(v9css);

await import('./v9-suite.js');
await import('./visual-coach-v72.js');
await import('./app.js');
await import('./zoom-controls-v73.js');
