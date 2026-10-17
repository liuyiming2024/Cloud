/* Cloud Drive · 身份适配层
 *
 * 本应用不自己做登录 —— 全站只有一个登录页：
 *   https://liuyiming2024.github.io/login.html
 *
 * 那份登录页由 assets/identity.js（SiteIdentity）支撑，
 * 会话写在 wxlg_sb_token / wxlg_sb_uid。
 * Cloud 与它在同一个 origin 下，localStorage 共享，所以那边登录完，这边直接认。
 *
 * 这里做的只有两件事：
 *   1. 有 SiteIdentity 就用它，别自己再读一遍 localStorage（读法一漂移，两边就不一致了）；
 *   2. 没有就退回读那两个 key，保证单独打开本页也不至于认不出人。
 *
 * 密码、冻结、爆破闸门这些规则一概不管 —— 全在服务端和 SiteIdentity 里。
 * 各项目各实现一份，必然漂移到"同一个账号在 A 会被冻结、在 B 不会"。
 */
(function () {
  var UNIFIED = 'https://liuyiming2024.github.io/assets/identity.js';
  var LOGIN_PAGE = 'https://liuyiming2024.github.io/login.html';

  var UID_KEY = 'wxlg_sb_uid';
  var TOK_KEY = 'wxlg_sb_token';
  // 老版本 Cloud 自己登过时写的 key。保留读取，保证存量会话不丢。
  var OLD_UID = 'code_cloud_uid';
  var OLD_TOK = 'code_cloud_token';

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  var SI = function () { return window.SiteIdentity || null; };

  /* 当前账号 id。SiteIdentity 在就用它的 state.id，否则自己读。 */
  function uid() {
    var s = SI();
    if (s && s.state) return s.state.id || null;
    return ls(UID_KEY) || ls(OLD_UID) || null;
  }
  function token() {
    var s = SI();
    if (s && typeof s.token === 'function') return s.token() || null;
    return ls(TOK_KEY) || ls(OLD_TOK) || null;
  }

  /* 昵称：只在 SiteIdentity 在场时才有，拿不到就算了 */
  function nick() {
    var s = SI();
    return (s && s.state && s.state.nick) || null;
  }

  /* 跳到统一登录页，登录完再回来。
     next 由 SiteIdentity._safeNext 过白名单 —— 它是相对路径，
     从 /Cloud/ 出发指向 /Cloud/index.html，同源，安全。 */
  function goLogin(back) {
    var next = back || 'index.html';
    var s = SI();
    if (s && typeof s.goLogin === 'function') { s.goLogin(next); return; }
    // SiteIdentity 还没加载完，就自己拼（相对路径，同样安全）
    location.href = LOGIN_PAGE + '?next=' + encodeURIComponent(
      location.pathname.replace(/[^/]*$/, '') + next
    );
  }

  function logout() {
    var s = SI();
    var p = (s && typeof s.logout === 'function')
      ? s.logout()
      : Promise.resolve();
    var clear = function () {
      // SiteIdentity 不在场（脚本没加载、加载失败）时，它不会去动 localStorage，
      // 那会话就还在 —— 用户点了退出、界面显示已退出、刷新发现还登着，会以为程序有鬼。
      // 所以无论它清没清，本地这几个 key 一定要清掉。
      lsSet(TOK_KEY, null); lsSet(UID_KEY, null);
      lsSet(OLD_TOK, null); lsSet(OLD_UID, null);
    };
    return p.then(function () { clear(); return { via: s ? 'SiteIdentity' : 'local' }; },
                  function () { clear(); return { via: 'local' }; });
  }

  /* 加载统一身份层。已加载则直接 resolve。 */
  function load(timeoutMs) {
    if (SI()) return Promise.resolve(SI());
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, timeoutMs || 6000);
      s.src = UNIFIED;
      s.onload = function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(SI());
      };
      s.onerror = function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(null);
      };
      document.head.appendChild(s);
    });
  }

  window.CloudAuth = {
    uid: uid, token: token, nick: nick,
    goLogin: goLogin, logout: logout, load: load,
    LOGIN_PAGE: LOGIN_PAGE,
    KEY: { UID: UID_KEY, TOK: TOK_KEY, OLD_UID: OLD_UID, OLD_TOK: OLD_TOK }
  };
})();
