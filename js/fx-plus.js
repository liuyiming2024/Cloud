/* ==========================================================================
   fx-plus.js · 为 fx-plus.css 注入效果所需 DOM
   引用自样式库：liuyiming2024/css_effect_map_collection
     · 滚动指示器  → 顶部进度条
     · 纯css气泡背景 → Hero 区气泡 <ul><li>
     · css边框四角  → 给 .card 加 .corner-box

   刻意不碰主题：各站点已有自己的亮暗切换（Cloud / Code 用
   [data-theme="dark"]，Chat / 主页用 body.dark），这里不接管、
   不创建第二个切换按钮、不写 localStorage 的主题键。
   ========================================================================== */
(function () {
  "use strict";

  function boot() {
    injectProgressBar();
    injectBubbles();
    markCorners();
    bindScroll();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ---- 滚动指示器（样式库：滚动指示器） ---- */
  function injectProgressBar() {
    if (document.getElementById("scroll-progress")) return;
    var bar = document.createElement("div");
    bar.id = "scroll-progress";
    document.body.appendChild(bar);
  }
  function bindScroll() {
    var bar = document.getElementById("scroll-progress");
    if (!bar) return;
    var ticking = false;
    function update() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var pct = h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0;
      bar.style.width = pct.toFixed(2) + "%";
      ticking = false;
    }
    function onScroll() {
      if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
  }

  /* ---- 气泡背景（样式库：纯css气泡背景） ---- */
  function injectBubbles() {
    var hero = document.querySelector(".hero");
    if (!hero || hero.querySelector(".bubble-bgwall")) return;
    var ul = document.createElement("ul");
    ul.className = "bubble-bgwall";
    ul.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 10; i++) ul.appendChild(document.createElement("li"));
    hero.insertBefore(ul, hero.firstChild);
  }

  /* ---- 四角装饰（样式库：css边框四角），只作用于卡片 ---- */
  function markCorners() {
    var cards = document.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) cards[i].classList.add("corner-box");
  }
})();
