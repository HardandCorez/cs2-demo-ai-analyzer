// Единый перехват fetch должен быть установлен до загрузки остальных модулей.
await import('./analysis-events.js');

const v10LiteCss=document.createElement('link');
v10LiteCss.rel='stylesheet';
v10LiteCss.href='/v10-lite.css';
document.head.appendChild(v10LiteCss);

const v10AllCss=document.createElement('link');
v10AllCss.rel='stylesheet';
v10AllCss.href='/v10-lite-allplayers.css';
document.head.appendChild(v10AllCss);

await import('./match-history.js');
await import('./fastcore-ui.js');
await import('./app.js');
await import('./v10-lite.js');
await import('./v10-lite-allplayers.js');

const brandSub=document.querySelector('.brand-sub');
if(brandSub)brandSub.textContent='CS2 demo intelligence · Unified Core 5.0';

const heroEyebrow=document.querySelector('.hero .eyebrow');
if(heroEyebrow)heroEyebrow.textContent='REAL .DEM PARSER + EPISODE COACH + MATCH HISTORY';

const heroText=document.querySelector('.hero-copy p');
if(heroText)heroText.innerHTML='Загрузи полноценный <strong>.dem</strong>. Единое ядро разбирает статистику и positioning одним tick-проходом; если демка несовместима, автоматически включается проверенное стабильное ядро. Эпизодный replay открывает выбранные 8-секундные фрагменты.';

const firstKpi=document.querySelector('.hero-kpis .mini-card');
if(firstKpi)firstKpi.innerHTML='<b>Unified</b><span>Core 5.0</span>';

const footer=document.querySelector('footer');
if(footer)footer.textContent='HardandCore Demo AI · Unified Core 5.0 · Fast Core + automatic stable fallback';
