/*
 * IAS device notifications (Web Push). Shared helper used by the top bar.
 *   IAS.push.state()    -> 'unsupported' | 'insecure' | 'ios-install' | 'denied' | 'off' | 'on'
 *   await IAS.push.enable() / disable()     (enable must run from a click: the browser asks for permission)
 *   await IAS.push.unsubscribeThisDevice()  (called on logout so the next person on this computer gets nothing)
 * How long a notification stays on screen is decided by the browser and the OS settings, not by IAS.
 */
(function (global) {
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const jsonPost = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const toKey = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };

  let regPromise = null;
  function register() {
    if (!supported()) return Promise.resolve(null);
    if (!regPromise) regPromise = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
    return regPromise;
  }

  async function currentSub() {
    const reg = await register();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function state() {
    if (!window.isSecureContext) return 'insecure';
    if (!supported()) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const sub = await currentSub();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }

  async function enable() {
    const reg = await register();
    if (!reg) throw new Error('unsupported');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return state();
    const k = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(k.publicKey) });
    const res = await jsonPost('/api/push/subscribe', sub.toJSON());
    if (!res.ok) throw new Error('subscribe failed');
    return 'on';
  }

  async function disable() {
    const sub = await currentSub();
    if (sub) { try { await jsonPost('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch (_) {} await sub.unsubscribe(); }
    return state();
  }

  // On login/page load: keep the server's copy of this device's subscription fresh (it may be re-assigned to the current user).
  async function sync() {
    if (!supported() || Notification.permission !== 'granted') return;
    const sub = await currentSub();
    if (sub) { try { await jsonPost('/api/push/subscribe', sub.toJSON()); } catch (_) {} }
  }

  async function unsubscribeThisDevice() {
    try {
      if (!supported()) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await jsonPost('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    } catch (_) { /* logging out must never fail because of this */ }
  }

  function onMessage(fn) { if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'ias-notify') fn(); }); }

  global.IAS = global.IAS || {};
  global.IAS.push = { state, enable, disable, sync, register, unsubscribeThisDevice, onMessage };
})(window);
