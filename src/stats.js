/**
 * Minimal performance HUD — frame time (MS) and JS heap (MB) panels with scrolling
 * graphs. Dependency-free, inspired by mrdoob/stats.js but trimmed to two panels.
 *
 * Usage:
 *   import createStats from './stats.js';
 *   const stats = createStats();
 *   document.body.appendChild(stats.dom);
 *   // per frame:
 *   stats.begin();  // top of the render loop
 *   …render…
 *   stats.end();    // after renderer.render()
 */

const PR = Math.round(window.devicePixelRatio || 1);
const WIDTH = 80 * PR, HEIGHT = 48 * PR;
const TEXT_X = 3 * PR, TEXT_Y = 2 * PR;
const GRAPH_X = 3 * PR, GRAPH_Y = 15 * PR;
const GRAPH_W = 74 * PR, GRAPH_H = 30 * PR;

/**
 * @param {string} name  label, e.g. 'MS' or 'MB'
 * @param {string} fg    foreground colour
 * @param {string} bg    background colour
 */
function makePanel(name, fg, bg) {
  let min = Infinity, max = 0;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.cssText = 'width:80px;height:48px;display:block';

  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${9 * PR}px monospace`;
  ctx.textBaseline = 'top';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = fg;
  ctx.fillText(name, TEXT_X, TEXT_Y);
  ctx.fillRect(GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H);
  ctx.fillStyle = bg;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H);

  return {
    dom: canvas,
    /** @param {number} value @param {number} maxValue graph full-scale */
    update(value, maxValue) {
      min = Math.min(min, value);
      max = Math.max(max, value);

      ctx.fillStyle = bg;
      ctx.globalAlpha = 1;
      ctx.fillRect(0, 0, WIDTH, GRAPH_Y);
      ctx.fillStyle = fg;
      ctx.fillText(`${Math.round(value)} ${name} (${Math.round(min)}-${Math.round(max)})`, TEXT_X, TEXT_Y);

      // Scroll the graph 1px left, then draw the new sample column on the right.
      ctx.drawImage(canvas, GRAPH_X + PR, GRAPH_Y, GRAPH_W - PR, GRAPH_H, GRAPH_X, GRAPH_Y, GRAPH_W - PR, GRAPH_H);
      ctx.fillRect(GRAPH_X + GRAPH_W - PR, GRAPH_Y, PR, GRAPH_H);
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(GRAPH_X + GRAPH_W - PR, GRAPH_Y, PR, Math.round((1 - value / maxValue) * GRAPH_H));
    },
  };
}

/**
 * Create the stats HUD. Pinned to the top-left of the viewport (below the top bar).
 * @returns {{ dom: HTMLElement, begin: () => void, end: () => number }}
 */
export default function createStats() {
  const dom = document.createElement('div');
  dom.id = 'stats';
  dom.style.cssText =
    'position:fixed;top:48px;left:8px;z-index:40;opacity:0.85;pointer-events:none;' +
    'display:flex;flex-direction:column;gap:2px';

  const msPanel = makePanel('MS', '#0ff', '#002');
  const memSupported = typeof performance !== 'undefined' && performance.memory;
  const memPanel = memSupported ? makePanel('MB', '#f0f', '#201') : null;

  dom.appendChild(msPanel.dom);
  if (memPanel) dom.appendChild(memPanel.dom);

  let beginTime = (performance || Date).now();

  return {
    dom,
    begin() {
      beginTime = (performance || Date).now();
    },
    end() {
      const now = (performance || Date).now();
      msPanel.update(now - beginTime, 33);  // full-scale ≈ 33 ms (~30 fps)
      if (memPanel) {
        const used = performance.memory.usedJSHeapSize / 1048576;
        memPanel.update(used, performance.memory.jsHeapSizeLimit / 1048576);
      }
      return now;
    },
  };
}
