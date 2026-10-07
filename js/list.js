/*
 * IAS list helpers
 *   IAS.stickyShadow(el) - adds .scrolled to a .tlist once it is scrolled, so the pinned header gets a shadow
 */
(function (global) {
  function stickyShadow(el) {
    const on = () => el.classList.toggle('scrolled', el.scrollTop > 2);
    el.addEventListener('scroll', on, { passive: true }); on();
  }
  global.IAS = global.IAS || {};
  global.IAS.stickyShadow = stickyShadow;
})(window);
