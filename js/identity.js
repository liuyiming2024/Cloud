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
  // 全站统一会话键（SiteIdentity 用的就是这两个）
  var CHAT_UID = 'wxlg_sb_uid';
  var CHAT_TOK = 'wxlg_sb_token';
  var CODE_UID = 'code_cloud_uid';   // 老版本 Cloud 自己写的，保留读取
  var CODE_TOK = 'code_cloud_token';

  // 后端地址与密钥不在这里写。
  // 之前这里有一份硬编码的 fallback，看着是"兜底"，实际是第二份真源 ——
  // 两处必然漂移，而且把连接信息摊在了每个文件里。
  // 现在一律走 window.CloudAuth.rpc()，那边统一管。
  // 拿不到就降级，不去自己拼 URL。

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

  /* ---------- 当前账号 ----------
   * 优先走 CloudAuth 的判定（它会尊重"主动退出过"这个标记），
   * 取不到再按老办法读，保证单独引入本文件时也能用。 */
  function account() {
    var uid = '', tok = '', from = '全站统一账号';
    if (window.CloudAuth) {
      // 走适配层：有 SiteIdentity 就用它的判定，别自己再读一遍
      uid = window.CloudAuth.uid() || '';
      tok = window.CloudAuth.token() || '';
    } else {
      uid = ls(CHAT_UID) || ls(CODE_UID) || '';
      tok = ls(CHAT_TOK) || ls(CODE_TOK) || '';
    }
    if (!uid) return null;
    return { uid: uid, token: tok, from: from, short: uid.slice(0, 8) };
  }

  var ANON_KEY = 'cloud_drive_anon_uid';

  /* ---------- 归属 id（决定文件存在哪个子目录） ----------
   * 登录了就是账号 uid；没登录就用一个本机生成的匿名 id。
   *
   * 匿名 id 存在 localStorage —— 它有和"专业模式口令"一样的性质：
   * 不上传、不备份，清了浏览器数据就没了，那些文件也就再也找不回来。
   * 所以界面上必须把这句话说清楚，不能让人稀里糊涂地用。 */
  function anonUid() {
    var v = ls(ANON_KEY);
    if (v) return v;
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    v = 'anon-' + Array.prototype.map.call(a, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
    lsSet(ANON_KEY, v);
    return v;
  }

  /* 当前这份文件归谁 —— 登录了归账号，没登录归这台浏览器 */
  function ownerId() {
    var a = account();
    return a ? a.uid : anonUid();
  }
  function isAnon() { return !account(); }

  /* 匿名模式只有一把口令：写死在 config 里的那个，没得选。
   *
   * 这不是偷懒 —— 匿名上传的东西是"交给站长的"，站长必须能打开。
   * 要让站长能打开，口令就不能由这台浏览器随机决定。
   * 所以匿名模式下模式切换是被禁掉的（见 app.js 的 paint()），
   * 用户选不了别的口令，也就不会误以为自己传的东西是保密的。 */
  function anonPass() {
    return (window.CloudCfg && window.CloudCfg.anonPass) || '';
  }

  /* ---------- 查账号创建时间 ----------
   *
   * 只走 RPC 函数层，不直接查 users 表。
   * 直接查表 = 拿 anon key 去读数据表，安全性全压在 RLS 上；
   * RLS 配错一次就是整张表可读。RPC 由函数自己决定给什么，不依赖表的 policy。
   *
   * 这个函数不一定存在（要站长在库里建）。不存在就返回 ''，
   * 口令少一个因子而已，照样能用 —— 不能因为拿不到就退回直连表。 */
  function fetchCreatedAt(uid) {
    if (!uid) return Promise.resolve('');
    if (!window.CloudAuth || typeof window.CloudAuth.rpc !== 'function') {
      return Promise.resolve('');
    }
    return window.CloudAuth.rpc('user_created_at', { p_uid: uid }).then(function (r) {
      if (r == null) return '';
      if (typeof r === 'string') return r;
      if (r.created_at) return String(r.created_at);
      if (r.ok === false) return '';
      return '';
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
    anonUid: anonUid,
    ownerId: ownerId,
    isAnon: isAnon,
    anonPass: anonPass,
    fetchCreatedAt: fetchCreatedAt,
    derivePass: derivePass,
    keyId: keyId,
    mode: mode,
    setMode: setMode
  };
})();
