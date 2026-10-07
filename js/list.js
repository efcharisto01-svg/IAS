/*
 * IAS list helpers
 *   IAS.stickyShadow(bodyEl) - adds .scrolled to the parent .hboard (헤더게시판) once the .hboard-body is scrolled, so the pinned header gets a shadow
 */
(function (global) {
  function stickyShadow(el) {
    const host = el.closest('.hboard') || el;
    const on = () => host.classList.toggle('scrolled', el.scrollTop > 2);
    el.addEventListener('scroll', on, { passive: true }); on();
  }
  global.IAS = global.IAS || {};
  global.IAS.stickyShadow = stickyShadow;
})(window);
