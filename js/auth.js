/* Cloud Drive · 登录
 *
 * 账号体系是复用 Chat / Code 的：同一个 Supabase 项目、同一张 users 表、
 * 同一套会话。三个页面都在 liuyiming2024.github.io 下，同源共享 localStorage，
 * 所以在任何一个页面登录，另外两个都认得出你。
 *
 * 沿用 Code 的那条规矩：
 *   登录 = 两边都写（自己的 key + Chat 的 key），这样在 Cloud 登录，回到 Chat 也是同一个人。
 *   登出 = 只清自己的，并写一个"拒绝沿用"标记 —— Chat 的会话我们无权删，
 *          但可以让本应用这一侧不再把它拿来用，否则刷新一下又被沿用回来，
 *          用户点了退出、界面显示已退出、刷新发现还登着，会以为程序有鬼。
 *
 * 密码只往服务端送，前端不碰任何人的 pwd_hash。
 */
(function () {
  var SB_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var SB_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  // 与 Chat / Code 一致的两个 key，都写，保证跨应用身份统一
  var CHAT_TOK = 'wxlg_sb_token', CHAT_UID = 'wxlg_sb_uid';
  var CODE_TOK = 'code_cloud_token', CODE_UID = 'code_cloud_uid';
  var OPT_OUT = 'cloud_drive_optout';

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  function token() {
    if (ls(OPT_OUT) === '1') return ls(CODE_TOK) || null; // 主动退出过：只认自己登的
    return ls(CODE_TOK) || ls(CHAT_TOK) || null;
  }
  function uid() {
    if (ls(OPT_OUT) === '1') return ls(CODE_UID) || null;
    return ls(CODE_UID) || ls(CHAT_UID) || null;
  }

  function rpc(name, params) {
    var h = { apikey: SB_KEY, 'Content-Type': 'application/json' };
    var t = token();
    if (t) h['x-session'] = t;
    return fetch(SB_URL + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: h, body: JSON.stringify(params || {})
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (text) {
          var m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
          var msg = m ? m[1].replace(/\\"/g, '"') : ('请求失败 ' + r.status);
          if (r.status === 401 || r.status === 403) msg = '登录已失效，请重新登录';
          var e = new Error(msg);
          e.status = r.status;
          throw e;
        });
      }
      var ct = r.headers.get('content-type') || '';
      if (r.status === 204 || !ct) return null;
      if (ct.indexOf('json') < 0) return r.text();
      return r.json();
    });
  }

  function okRpc(name, params) {
    return rpc(name, params).then(function (j) {
      if (j && j.ok === false) throw new Error(j.err || '操作失败');
      return j;
    });
  }

  /* 写会话：自己的 key 必写，Chat 的 key 也写，让它那边认出这次登录 */
  function setSession(tok, id) {
    lsSet(CODE_TOK, tok || null);
    lsSet(CODE_UID, id || null);
    if (tok) {
      lsSet(OPT_OUT, null);           // 主动登录 → 撤销"已退出"标记
      lsSet(CHAT_TOK, tok);
      if (id) lsSet(CHAT_UID, id);
    }
  }

  function dropSession() {
    lsSet(CODE_TOK, null);
    lsSet(CODE_UID, null);
    lsSet(OPT_OUT, '1');              // 不再沿用 Chat 的登录态
  }

  /* ---------- 各操作 ---------- */

  function siteReady() { return rpc('site_ready', {}); }

  /* 过站点保护密码。
   *
   * 现在站点是「无门模式」（gate_disabled），登录不需要先过门禁，
   * 所以登录页不再走这一步 —— 这个函数留着只是为了兜底：
   * 万一哪天站点重新开了保护密码，调用方能直接拿到它，不用再翻一遍 RPC。
   * 账号这道门还在原处，取消保护密码不等于公开站点内容。 */
  function gateCheck(pwd) {
    return rpc('gate_check', { p: pwd }).then(function (t) {
      if (!t) throw new Error('保护密码错误');
      setSession(t, null);
      return t;
    });
  }

  function login(nick, pwd) {
    return rpc('user_login', { p_nick: nick, p_pwd: pwd }).then(function (r) {
      if (!r || !r.token) throw new Error('昵称或密码错误');
      setSession(r.token, r.uid);
      return r;
    });
  }

  function register(nick, pwd) {
    return okRpc('user_register', { p_nick: nick, p_pwd: pwd, p_real: '' });
  }

  /* 票据兑换：在 Chat 里申领一串码，在这里换会话，免输密码。
     因为两边同源，票据自带的 origin 校验天然通过。 */
  function redeem(code) {
    var origin = '';
    try { origin = location.origin || ''; } catch (e) {}
    return rpc('bridge_ticket_redeem', { p_code: code, p_origin: origin }).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && j.err) || '票据无效');
      if (j.token) setSession(j.token, j.uid);
      return j;
    });
  }

  function logout() {
    var shared = !ls(CODE_TOK) && !!ls(CHAT_TOK); // 登录态是借来的
    return rpc('logout', {}).then(function () { dropSession(); }, function () { dropSession(); })
      .then(function () { return { shared: shared }; });
  }

  /* 我是谁 */
  function me() {
    var id = uid();
    if (!id) return Promise.resolve(null);
    return rpc('code_me', {}).then(function (j) { return j || null; },
      function () { return null; });
  }

  window.CloudAuth = {
    token: token, uid: uid, setSession: setSession, dropSession: dropSession,
    siteReady: siteReady, gateCheck: gateCheck, login: login,
    register: register, redeem: redeem, logout: logout, me: me,
    // 后端地址只有这一处。identity.js 要用就从这儿取，别再抄一份
    SB_URL: SB_URL, SB_KEY: SB_KEY,
    KEY: { OPT_OUT: OPT_OUT, CODE_TOK: CODE_TOK, CODE_UID: CODE_UID, CHAT_TOK: CHAT_TOK, CHAT_UID: CHAT_UID }
  };
})();
