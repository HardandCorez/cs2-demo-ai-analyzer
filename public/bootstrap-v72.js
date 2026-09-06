const v9css = document.createElement('link');
v9css.rel = 'stylesheet';
v9css.href = '/v9.css';
document.head.appendChild(v9css);

await import('./v9-suite.js');
await import('./visual-coach-v72.js');
await import('./app.js');
await import('./zoom-controls-v73.js');

const brandSub = document.querySelector('.brand-sub');
if (brandSub) brandSub.textContent = 'CS2 demo intelligence · V9 Unified Coach';
const heroEyebrow = document.querySelector('.hero .eyebrow');
if (heroEyebrow) heroEyebrow.textContent = 'REAL .DEM PARSER + SMOOTH 2D REPLAY + TELEMETRY + LOCAL AI';
const heroText = document.querySelector('.hero-copy p');
if (heroText) heroText.innerHTML = 'Загрузи полноценный <strong>.dem</strong>. V9 объединяет плавный 2D replay, utility, duel/aim telemetry, критические эпизоды, Visual Coach и локальный AI-разбор конкретной ошибки.';
const firstKpi = document.querySelector('.hero-kpis .mini-card');
if (firstKpi) firstKpi.innerHTML = '<b>V9</b><span>unified coach</span>';
const footer = document.querySelector('footer');
if (footer) footer.textContent = 'HardandCore Demo AI · V9 unified coach · local .dem processing + Ollama';
