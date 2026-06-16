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

/** Make `el` draggable by pointer; updates fixed left/top so it can be repositioned. */
function makeDraggable(el) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  el.style.cursor = 'move';
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    el.style.left = `${ox + (e.clientX - sx)}px`;
    el.style.top  = `${oy + (e.clientY - sy)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  const stop = (e) => { dragging = false; el.releasePointerCapture?.(e.pointerId); };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

/** Compact number formatting for the render-info readout (1234567 → "1.23M"). */
function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * Create the draggable debug HUD: frame time (MS), JS heap (MB), and a live three.js
 * render-info readout (triangles, draw calls, geometries/textures/programs). Hidden by
 * default — toggle with setVisible(). Pinned top-left initially; drag to reposition.
 * @returns {{ dom: HTMLElement, visible: boolean, setVisible: (v:boolean)=>void,
 *             begin: ()=>void, end: (renderer?:import('three').WebGLRenderer)=>number }}
 */
export default function createStats() {
  const dom = document.createElement('div');
  dom.id = 'stats';
  dom.style.cssText =
    'position:fixed;top:48px;left:8px;z-index:40;opacity:0.9;' +
    'display:none;flex-direction:column;gap:2px;user-select:none;touch-action:none';

  const fpsPanel = makePanel('FPS', '#0f0', '#020');
  const msPanel = makePanel('MS', '#0ff', '#002');
  const memSupported = typeof performance !== 'undefined' && performance.memory;
  const memPanel = memSupported ? makePanel('MB', '#f0f', '#201') : null;

  // three.js render-info readout (text, not a graph)
  const infoEl = document.createElement('div');
  infoEl.style.cssText =
    'width:80px;background:#021;color:#9f9;font:bold 9px/1.35 monospace;' +
    'padding:3px 4px;white-space:pre;box-sizing:border-box';
  infoEl.textContent = '— tris\n— draws';

  dom.appendChild(fpsPanel.dom);
  dom.appendChild(msPanel.dom);
  if (memPanel) dom.appendChild(memPanel.dom);
  dom.appendChild(infoEl);
  makeDraggable(dom);

  let beginTime = (performance || Date).now();
  let visible = false;
  // FPS = frames counted over a ~1 s window
  let frames = 0;
  let prevTime = beginTime;

  return {
    dom,
    get visible() { return visible; },
    setVisible(v) {
      visible = v;
      dom.style.display = v ? 'flex' : 'none';
      if (v) { frames = 0; prevTime = (performance || Date).now(); } // fresh FPS window
    },
    begin() {
      beginTime = (performance || Date).now();
    },
    /**
     * Call right after `renderer.render(scene, camera)` (before any extra passes, so
     * renderer.info still reflects the main scene). Skips all drawing when hidden.
     * @param {import('three').WebGLRenderer} [renderer]
     */
    end(renderer) {
      const now = (performance || Date).now();
      if (!visible) return now;
      msPanel.update(now - beginTime, 33);  // full-scale ≈ 33 ms (~30 fps)
      // FPS over a rolling ~1 s window
      frames++;
      if (now >= prevTime + 1000) {
        fpsPanel.update((frames * 1000) / (now - prevTime), 100); // full-scale 100 fps
        prevTime = now;
        frames = 0;
      }
      if (memPanel) {
        const used = performance.memory.usedJSHeapSize / 1048576;
        memPanel.update(used, performance.memory.jsHeapSizeLimit / 1048576);
      }
      if (renderer) {
        const r = renderer.info.render, m = renderer.info.memory;
        infoEl.textContent =
          `${fmt(r.triangles)} tris\n${r.calls} draws\n` +
          `${m.geometries} geo ${m.textures} tex\n${renderer.info.programs?.length ?? 0} prog`;
      }
      return now;
    },
  };
}
