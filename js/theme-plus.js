/* ==========================================================================
   theme-plus.js
   配套 theme-plus.css。效果引用自样式库 css_effect_map_collection。
   注意：主题读取与落地必须在 <head> 同步执行，否则会出现「先白后黑」的闪烁。
   ========================================================================== */
(function () {
  "use strict";
  var KEY = "site-theme";
  var root = document.documentElement;

  // ---------- 1. 主题：读取持久化偏好（首次访问跟随系统）----------
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  root.setAttribute("data-theme", saved || "auto");

  // ---------- 2. 注入效果所需的 DOM（等 DOM 就绪）----------
  function boot() {
    injectProgressBar();
    injectBubbles();
    markCorners();
    buildToggle();
    bindScroll();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 滚动指示器
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
      var pct = h > 0 ? (window.scrollY / h) * 100 : 0;
      bar.style.width = pct.toFixed(2) + "%";
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
    }, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
  }

  // 气泡背景（样式库：纯css气泡背景）
  function injectBubbles() {
    var hero = document.querySelector(".hero");
    if (!hero || hero.querySelector(".bubble-bgwall")) return;
    var ul = document.createElement("ul");
    ul.className = "bubble-bgwall";
    ul.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 10; i++) ul.appendChild(document.createElement("li"));
    hero.insertBefore(ul, hero.firstChild);
  }

  // 四角装饰（样式库：css边框四角）—— 只给卡片加
  function markCorners() {
    var cards = document.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) cards[i].classList.add("corner-box");
  }

  // ---------- 3. 切换按钮 ----------
  var ICON = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    dark:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    auto:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/></svg>'
  };
  var LABEL = { light: "浅色", dark: "深色", auto: "跟随系统" };
  var ORDER = ["auto", "light", "dark"];

  function current() { return root.getAttribute("data-theme") || "auto"; }

  function apply(mode, persist) {
    root.setAttribute("data-theme", mode);
    if (persist) { try { localStorage.setItem(KEY, mode); } catch (e) {} }
    refresh();
  }

  function refresh() {
    var mode = current();
    var btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    btn.innerHTML = ICON[mode] + "<span>" + LABEL[mode] + "</span>";
    btn.setAttribute("title", "主题：" + LABEL[mode] + "（点击切换）");
    btn.setAttribute("aria-label", "切换主题，当前" + LABEL[mode]);
  }

  function buildToggle() {
    if (document.querySelector(".theme-toggle")) { refresh(); return; }
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    btn.addEventListener("click", function () {
      var next = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
      apply(next, true);
    });

    // 优先放进导航工具区，找不到就浮动到右下角
    var slot =
      document.querySelector(".nav-tools") ||
      document.querySelector(".nav .nav-inner") ||
      document.querySelector("nav") ||
      document.querySelector("#topbar");
    if (slot) {
      slot.appendChild(btn);
    } else {
      btn.classList.add("is-floating");
      document.body.appendChild(btn);
    }
    refresh();
  }

  // 用户没手动选过时，跟随系统实时变化
  var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) {
    mq.addEventListener("change", function () {
      if (!saved) root.setAttribute("data-theme", "auto");
    });
  }

  // 供外部调用
  window.ThemePlus = { apply: apply, get: current };
})();
