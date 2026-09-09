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
if(brandSub)brandSub.textContent='CS2 demo intelligence · V10 Lite 4.4 Fast Core';

const heroEyebrow=document.querySelector('.hero .eyebrow');
if(heroEyebrow)heroEyebrow.textContent='FAST .DEM CORE · EPISODE COACH + MATCH HISTORY';

const heroText=document.querySelector('.hero-copy p');
if(heroText)heroText.innerHTML='Загрузи полноценный <strong>.dem</strong>. Fast Core старается собрать основную статистику, positioning и составы одним tick-проходом; если демка несовместима, автоматически включается проверенное стабильное ядро. V10 Lite по-прежнему открывает только выбранные 8-секундные эпизоды.';

const firstKpi=document.querySelector('.hero-kpis .mini-card');
if(firstKpi)firstKpi.innerHTML='<b>V10 Lite</b><span>Fast Core 4.4</span>';

const footer=document.querySelector('footer');
if(footer)footer.textContent='HardandCore Demo AI · V10 Lite 4.4 · Fast Core + automatic stable fallback';
