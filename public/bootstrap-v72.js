const v10LiteCss=document.createElement('link');
v10LiteCss.rel='stylesheet';
v10LiteCss.href='/v10-lite.css';
document.head.appendChild(v10LiteCss);

const v10AllCss=document.createElement('link');
v10AllCss.rel='stylesheet';
v10AllCss.href='/v10-lite-allplayers.css';
document.head.appendChild(v10AllCss);

await import('./match-history.js');
await import('./app.js');
await import('./v10-lite.js');
await import('./v10-lite-allplayers.js');

const brandSub=document.querySelector('.brand-sub');
if(brandSub)brandSub.textContent='CS2 demo intelligence · V10 Lite 4.3.1';

const heroEyebrow=document.querySelector('.hero .eyebrow');
if(heroEyebrow)heroEyebrow.textContent='REAL .DEM PARSER · EPISODE COACH + MATCH HISTORY';

const heroText=document.querySelector('.hero-copy p');
if(heroText)heroText.innerHTML='Загрузи полноценный <strong>.dem</strong>. Стабильное ядро разбирает матч, V10 Lite открывает отдельные 8-секундные эпизоды всех игроков, а страница «Матчи» сохраняет локальную историю, тренды и повторяющиеся ошибки.';

const firstKpi=document.querySelector('.hero-kpis .mini-card');
if(firstKpi)firstKpi.innerHTML='<b>V10 Lite</b><span>all-player episode coach</span>';

const footer=document.querySelector('footer');
if(footer)footer.textContent='HardandCore Demo AI · V10 Lite 4.3.1 · all-player episodes + match history';
