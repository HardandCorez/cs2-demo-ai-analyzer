const v10LiteCss=document.createElement('link');
v10LiteCss.rel='stylesheet';
v10LiteCss.href='/v10-lite.css';
document.head.appendChild(v10LiteCss);

await import('./app.js');
await import('./v10-lite.js');

const brandSub=document.querySelector('.brand-sub');
if(brandSub)brandSub.textContent='CS2 demo intelligence · V10 Lite 4.2';

const heroEyebrow=document.querySelector('.hero .eyebrow');
if(heroEyebrow)heroEyebrow.textContent='REAL .DEM PARSER · PER-PLAYER EPISODE REPLAY + SAFE-DEFAULT COACH';

const heroText=document.querySelector('.hero-copy p');
if(heroText)heroText.innerHTML='Загрузи полноценный <strong>.dem</strong>. Базовый анализ остаётся на стабильном ядре. Для любого игрока V10 Lite открывает отдельный 8-секундный replay и сразу разбирает только этот эпизод: почему он рискованный и какой safe-default вариант выбрать вместо него.';

const firstKpi=document.querySelector('.hero-kpis .mini-card');
if(firstKpi)firstKpi.innerHTML='<b>V10 Lite</b><span>episode coach</span>';

const footer=document.querySelector('footer');
if(footer)footer.textContent='HardandCore Demo AI · V10 Lite 4.2 · stable core + episode-only coach';
