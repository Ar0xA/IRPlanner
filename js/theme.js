// Light / dark theme. Loaded as a plain script in <head> so the page never flashes the wrong
// theme. Dark is the default; the toggle saves the visitor's choice.
(function () {
  var KEY = 'irplanner.theme';
  var root = document.documentElement;

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#e4e9ec' : '#0a0e12';
    var button = document.getElementById('theme-toggle');
    if (button) {
      var label = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  function current() {
    return saved() || 'dark';
  }

  apply(current());

  document.addEventListener('DOMContentLoaded', function () {
    apply(current());
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(KEY, next); } catch (e) { /* still switches for this page view */ }
      apply(next);
    });
  });
})();
