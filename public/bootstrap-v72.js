const v10LiteCss=document.createElement('link');
v10LiteCss.rel='stylesheet';
v10LiteCss.href='/v10-lite.css';
document.head.appendChild(v10LiteCss);

const v10AllCss=document.createElement('link');
v10AllCss.rel='stylesheet';
v10AllCss.href='/v10-lite-allplayers.css';
document.head.appendChild(v10AllCss);

const v10FpsCss=document.createElement('link');
v10FpsCss.rel='stylesheet';
v10FpsCss.href='/v10-fps.css';
document.head.appendChild(v10FpsCss);

await import('./match-history.js');
await import('./app.js');
await import('./v10-lite.js');
await import('./v10-lite-allplayers.js');
await import('./v10-fps.js');

const brandSub=document.querySelector('.brand-sub');
if(brandSub)brandSub.textContent='CS2 demo intelligence · V10 Lite 4.3.3';

const heroEyebrow=document.querySelector('.hero .eyebrow');
if(heroEyebrow)heroEyebrow.textContent='REAL .DEM PARSER · EPISODE COACH + MATCH HISTORY';

const heroText=document.querySelector('.hero-copy p');
if(heroText)heroText.innerHTML='Загрузи полноценный <strong>.dem</strong>. Стабильное ядро разбирает матч, V10 Lite показывает эпизоды выбранного игрока и отдельный 8-секундный Coach, а replay теперь показывает DATA FPS и фактический RENDER FPS браузера.';

const firstKpi=document.querySelector('.hero-kpis .mini-card');
if(firstKpi)firstKpi.innerHTML='<b>V10 Lite</b><span>selected-player coach</span>';

const footer=document.querySelector('footer');
if(footer)footer.textContent='HardandCore Demo AI · V10 Lite 4.3.3 · selected-player episodes + live FPS HUD';
