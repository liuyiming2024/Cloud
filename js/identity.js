/* Cloud Drive · 身份与口令模式
 *
 * 两种模式：
 *   简单模式 —— 口令由账号派生，你不用记。换设备只要登录同一个账号，口令自动算出来。
 *   专业模式 —— 口令你自己定，谁都算不出来，但忘了就是忘了。
 *
 * 为什么简单模式不能只拿 uid 算：
 *   uid 是账号的唯一标识，但它单独一个因子太"薄"—— 一旦有人拿到 uid，
 *   配合本文件的算法就能算出同一个口令。所以把**账号创建时间**一起混进来，
 *   并且**首次算完之后就把这组因子固定下来**（快照写进私有存储库），
 *   以后永远用快照算，不跟着账号资料变。这样：
 *     · 口令是确定的 —— 同一账号，任何时候、任何设备，算出来都一样；
 *     · 口令是稳定的 —— 不会因为 Supabase 查不到、资料被改、网络抖动而变掉；
 *     · 口令是不可预测的 —— 多了一个账号级的固定因子。
 *
 * 固定的那组因子不是秘密（uid 本来就在浏览器的 localStorage 里），
 * 真正的防线是：密文在私有库里，而打开私有库需要那枚令牌。
 */
(function () {
  // 与 Chat / Code 共用的会话键。三个页面都在 liuyiming2024.github.io 下，同源共享 localStorage
  var CHAT_UID = 'wxlg_sb_uid';
  var CHAT_TOK = 'wxlg_sb_token';
  var CODE_UID = 'code_cloud_uid';
  var CODE_TOK = 'code_cloud_token';

  // Chat 与 Code 用的是同一个 Supabase 项目和同一把 publishable key，
  // 按它们的设计这把 key 本来就是公开的（等价于 anon key）
  var SB_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var SB_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  var APP_SALT = 'cloud-drive-simple-v1';      // 应用固定盐，公开无妨
  var HKDF_INFO = 'cloud-drive/simple-key';    // HKDF info，换它等于换一批口令

  var MODE_KEY = 'cloud_drive_mode';           // 本机记住上次选的模式
  var enc = new TextEncoder();

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  function b64url(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ---------- 当前账号 ---------- */
  // 顺序与 Code 的 cloud.js 一致：本应用自己登的优先，其次沿用 Chat 的
  function account() {
    var uid = ls(CODE_UID) || ls(CHAT_UID) || '';
    var tok = ls(CODE_TOK) || ls(CHAT_TOK) || '';
    if (!uid) return null;
    return {
      uid: uid,
      token: tok,
      from: ls(CODE_UID) ? 'Code' : 'Chat',
      short: uid.slice(0, 8)
    };
  }

  /* ---------- 查账号创建时间 ----------
   * 只在首次绑定时查一次。查不到不报错，降级成 uid-only，
   * 照样能用，只是少一个因子。快照一旦写下就不再依赖它。 */
  function fetchCreatedAt(uid) {
    var url = SB_URL + '/rest/v1/users?select=created_at&id=eq.' + encodeURIComponent(uid);
    return fetch(url, {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, Accept: 'application/json' }
    }).then(function (r) {
      if (!r.ok) return '';
      return r.json().then(function (j) {
        return (j && j[0] && j[0].created_at) ? String(j[0].created_at) : '';
      });
    }).catch(function () { return ''; });
  }

  /* ---------- 派生 ----------
   * HKDF-SHA256，256 位输出。
   *
   * round 是防重轮次：因子里多带了它，所以 round 变一位，出来的口令完全不同。
   * 平时 round=0；万一算出来的口令和别人撞了，round+1 再算一个，
   * 直到不撞为止。round 会随快照一起存下来，所以换设备也能算出同一个。 */
  function derivePass(uid, createdAt, round) {
    var material = uid + '|' + (createdAt || 'na') + '|r' + (round || 0) +
                   '|' + (window.CloudCfg && window.CloudCfg.simpleSalt || '');
    return crypto.subtle.importKey('raw', enc.encode(material), 'HKDF', false, ['deriveBits'])
      .then(function (k) {
        return crypto.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(APP_SALT), info: enc.encode(HKDF_INFO) },
          k, 256
        );
      })
      .then(function (bits) { return b64url(new Uint8Array(bits)); });
  }

  /* 口令的"编号"。
   *
   * 拿它做防重比对，而不是拿口令本身 —— 口令一旦出现在索引里就不再是口令了。
   * 这是单向的：能从口令算出编号，不能从编号倒推口令。
   * 比对的是编号是否重复，不是比文件内容。 */
  function keyId(pass) {
    return crypto.subtle.digest('SHA-256', enc.encode('keyid:' + pass))
      .then(function (d) { return b64url(new Uint8Array(d)).slice(0, 22); });
  }

  /* ---------- 模式 ---------- */
  function mode() { return ls(MODE_KEY) || 'simple'; }
  function setMode(m) { lsSet(MODE_KEY, m === 'pro' ? 'pro' : 'simple'); }

  window.CloudId = {
    account: account,
    fetchCreatedAt: fetchCreatedAt,
    derivePass: derivePass,
    keyId: keyId,
    mode: mode,
    setMode: setMode
  };
})();
