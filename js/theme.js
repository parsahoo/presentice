// Theme: dark by default, whatever the system setting says. A light theme is one
// click away (the sun and moon button) and remembered on this device.
// A classic script in <head>, so the theme is set before the page first paints.
(function () {
  var KEY = 'presentice:theme';
  var root = document.documentElement;

  function saved() {
    try {
      return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
    } catch (err) {
      return 'dark'; // storage blocked: the default theme
    }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme);
    var label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    var buttons = document.querySelectorAll('[data-action="theme"]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-label', label);
      buttons[i].setAttribute('title', label);
    }
  }

  apply(saved());

  document.addEventListener('DOMContentLoaded', function () {
    apply(root.getAttribute('data-theme'));
    document.addEventListener('click', function (e) {
      var button = e.target instanceof Element ? e.target.closest('[data-action="theme"]') : null;
      if (!button) return;
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(KEY, next);
      } catch (err) {
        console.warn('The theme choice could not be saved on this device', err);
      }
      apply(next);
    });
  });
})();
