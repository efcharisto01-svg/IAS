/*
 * IAS widget registry. Each widget has its own file (the server catalog points to it, see server/apps.js):
 *   IAS.widgets.define('audit.recent', { render(body, ctx) { ...; return { stop() {} }; } });
 *   - body: the card's content area; draw into it with textContent / DOM (never innerHTML with server data)
 *   - ctx:  { me, go(link) }  go() opens the widget's app page
 *   - render may return { stop() } to clear timers when the card is removed
 * Home loads the file of every widget that is on screen, then calls render.
 */
(function (global) {
  const defs = {};
  const loading = {};
  const define = (id, def) => { defs[id] = def; };

  function load(w) {
    if (defs[w.id]) return Promise.resolve();
    if (!loading[w.script]) {
      loading[w.script] = new Promise((ok, no) => {
        const s = document.createElement('script'); s.src = w.script; s.onload = ok; s.onerror = () => no(new Error('load ' + w.script)); document.head.appendChild(s);
      });
    }
    return loading[w.script];
  }

  async function render(w, body, ctx) {
    try {
      await load(w);
      if (!defs[w.id]) throw new Error('not defined');
      return (await defs[w.id].render(body, ctx)) || null;
    } catch (_) {
      body.textContent = '';
      const n = document.createElement('div'); n.className = 'widget-note'; n.textContent = '불러오지 못했습니다'; body.appendChild(n);
      return null;
    }
  }

  global.IAS = global.IAS || {};
  global.IAS.widgets = { define, render };
})(window);
