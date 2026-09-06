await import('./app.js');

const brandSub=document.querySelector('.brand-sub');
if(brandSub)brandSub.textContent='CS2 demo intelligence · Recovery Build 4.0.1';

const heroEyebrow=document.querySelector('.hero .eyebrow');
if(heroEyebrow)heroEyebrow.textContent='REAL .DEM PARSER · STABLE CORE ANALYSIS';

const heroText=document.querySelector('.hero-copy p');
if(heroText)heroText.innerHTML='Загрузи полноценный <strong>.dem</strong>. В recovery-сборке временно отключён тяжёлый 2D replay-пайплайн, который зависал на 88%. Работают базовые метрики, scoreboard, timeline, positioning и AI-анализ.';

const firstKpi=document.querySelector('.hero-kpis .mini-card');
if(firstKpi)firstKpi.innerHTML='<b>4.0.1</b><span>stable recovery</span>';

const footer=document.querySelector('footer');
if(footer)footer.textContent='HardandCore Demo AI · stable recovery build · local processing';
