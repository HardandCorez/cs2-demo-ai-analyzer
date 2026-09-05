const $ = (selector) => document.querySelector(selector);

function dispatchZoom(deltaY) {
  const canvas = $('#positionCanvas');
  if (!canvas || canvas.classList.contains('hidden')) return;
  const rect = canvas.getBoundingClientRect();
  const event = new WheelEvent('wheel', {
    deltaY,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    bubbles: true,
    cancelable: true,
  });
  canvas.dispatchEvent(event);
}

function bindRepeat(button, deltaY) {
  let timer = null;
  let delayTimer = null;

  const stop = () => {
    if (delayTimer) clearTimeout(delayTimer);
    if (timer) clearInterval(timer);
    delayTimer = null;
    timer = null;
  };

  button.addEventListener('click', () => dispatchZoom(deltaY));
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    stop();
    delayTimer = setTimeout(() => {
      timer = setInterval(() => dispatchZoom(deltaY), 110);
    }, 360);
  });
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('pointerleave', stop);
}

function setupZoomButtons() {
  const controls = $('.radar-controls');
  const readout = $('#radarZoom');
  if (!controls || !readout || $('#radarZoomIn')) return;

  const group = document.createElement('div');
  group.className = 'radar-zoom-buttons';
  group.setAttribute('aria-label', 'Управление масштабом карты');
  group.innerHTML = `
    <button class="zoom-btn" id="radarZoomOut" type="button" title="Отдалить карту" aria-label="Отдалить карту">−</button>
    <button class="zoom-btn" id="radarZoomIn" type="button" title="Приблизить карту" aria-label="Приблизить карту">+</button>
  `;

  readout.insertAdjacentElement('beforebegin', group);
  bindRepeat($('#radarZoomOut'), 160);
  bindRepeat($('#radarZoomIn'), -160);
}

setupZoomButtons();
