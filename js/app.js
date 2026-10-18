/* Cloud Drive · 主流程
 *
 * 文件在你这里加密，密文经过一个公开的暂存区，由 Actions 搬进私有存储库。
 * 页面不知道那个私有库叫什么，也没有权限去碰它。
 *
 * 两种口令：
 *   简单模式 —— 口令由账号算出，换设备登录同一个账号就自动得到同一把。
 *              系统保证它全局唯一，撞了自动换一轮重算。
 *   专业模式 —— 口令你自己定，谁都算不出来，也检查不了唯一性，因为系统看不到它。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const state = {
    token: '',
    mode: 'simple',       // simple | pro
    proPass: '',          // 专业模式的口令，只在内存里
    account: null,        // {uid, token, from, short}
    createdAt: '',        // 账号注册时间，简单模式的因子之一
    round: 0,             // 简单模式当前轮次（防重用的）
    pass: '',             // 当前生效的口令
    kid: '',              // 当前口令的编号
    files: [],
    picked: new Set(),    // 批量导出勾选的文件
    keys: []              // 登记表里属于本账号的记录（含历史轮次）
  };

  /* ---------- 小工具 ---------- */
  function log(msg, kind) {
    const box = $('#log');
    const line = document.createElement('div');
    line.className = 'log-line' + (kind ? ' ' + kind : '');
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function randId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }

  /* 盲化账号标识：存到私有库的是这个，不是 uid 明文 */
  async function blindAid(uid) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('aid:' + uid));
    return btoa(String.fromCharCode(...new Uint8Array(d)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
  }

  /* ---------- 主题 ---------- */
  function initTheme() {
    const btn = $('#theme');
    function paint() {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.textContent = dark ? '☀️ 浅色' : '🌗 深色';
    }
    paint();
    btn.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      lsSet('cloud_drive_theme', next);
      paint();
    });
  }

  /* ---------- 模式切换 ---------- */
  function initMode() {
    const seg = $('#modeSeg');
    const hint = $('#modeHint');
    const HINTS = {
      simple: '钥匙自动算好，不用记，换电脑也在。',
      pro: '钥匙自己定，忘了就打不开了。'
    };
    function paint() {
      const anon = window.CloudId.isAnon();
      seg.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.mode === state.mode)
      );
      // 匿名时锁死：只有那一把固定口令，给不了选择。
      // 给了选择就是骗人 —— 选了专业模式，站长就打不开你交上去的东西了。
      // 匿名时强制只显示简单框。
      // 不能只看 state.mode —— 那是上次登录时存下来的，
      // 若是 'pro'，这里会把专业档的钥匙输入框显示出来，
      // 而 ensureKey 的匿名分支根本不读它（永远用固定钥匙）。
      // 结果就是：用户填了口令、以为生效了，实际用的是公开那把。
      // 宁可显示得"少了"，也不能让人产生这种误判。
      $('#simpleBox').style.display = (anon || state.mode === 'simple') ? '' : 'none';
      $('#proBox').style.display = (!anon && state.mode === 'pro') ? '' : 'none';
      $('#refreshKey').disabled = anon;
      seg.querySelectorAll('button').forEach((b) => { b.disabled = anon; });
      hint.textContent = anon
        ? '没登录：站长能看到你传的东西。要保密，先登录。'
        : HINTS[state.mode];
    }
    seg.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        if (window.CloudId.isAnon()) return;
        if (state.mode === b.dataset.mode) return;
        if (b.dataset.mode === 'pro' && !state.proPass) {
          if (!confirm('换成专业档？\n\n钥匙由你自己定并自己记住。忘了就永远打不开，没有找回。')) return;
        }
        state.mode = b.dataset.mode;
        window.CloudId.setMode(state.mode);
        paint();
        detectAccount();   // 切到简单模式而没账号时，把提示亮出来
        if (state.mode === 'simple') ensureKey();
        else { state.pass = state.proPass; state.kid = ''; }
      })
    );
    state.mode = window.CloudId.mode();
    paint();
  }

  /* ---------- 账号识别 ---------- */
  async function detectAccount() {
    const a = window.CloudId.account();
    state.account = a;
    if (!a) {
      // 未登录也能用：归到本机的匿名 id 下，照样能传能取
      $('#whoNick').textContent = '未登录 · 匿名使用';
      $('#whoSrc').textContent = '只认这台浏览器，换电脑就找不回了';
      $('#logout').style.display = 'none';
      $('#toLogin').style.display = '';
      // 匿名不是"功能缺失"，是"另一种约定"——必须把代价摆在眼前
      return false;
    }
    $('#whoNick').textContent = '已识别 · ' + a.short + '…';
    $('#whoSrc').textContent = '已登录';
    $('#logout').style.display = '';
    $('#toLogin').style.display = 'none';
    need.style.display = 'none';
    return true;
  }

  /* ---------- 拿到一把口令 ----------
   * 登录了：口令由账号派生，全局唯一，撞了自动换轮次。
   * 没登录：匿名模式，用 config 里那把写死的固定口令，没得选。 */
  async function ensureKey(forceRefresh) {
    if (!state.token && !window.CloudWorker.on()) { log('还没接上后端，暂时用不了。', 'err'); return false; }
    await detectAccount();

    // 匿名模式只有一把写死的口令，没有"算"这一过程，也不接受刷新。
    // 刷新口令在这里是无意义的：换了它，站长就打不开你交上去的东西了。
    if (window.CloudId.isAnon()) {
      state.pass = window.CloudId.anonPass();
      state.kid = await window.CloudId.keyId(state.pass);
      state.round = 0;
      $('#kidText').textContent = '匿名固定钥匙（不可改）';
      log('没登录：用的是固定钥匙，站长能打开你传的东西。', 'ok');
      return true;
    }

    // 走到这儿说明已登录：口令由账号 uid + 注册时间 + 轮次派生
    const oid = window.CloudId.ownerId();
    if (state.createdAt === '') {
      state.createdAt = await window.CloudId.fetchCreatedAt(oid);
      log(state.createdAt ? '已取到账号注册时间' : '取不到注册时间，口令只用账号因子（照样能用）');
    }
    const createdAt = state.createdAt;

    const aid = await blindAid(oid);
    let round = parseInt(lsGet('cloud_drive_round', '0'), 10);
    if (forceRefresh) round = round + 1;

    // 撞了就换一轮重算。轮次进因子，所以换一位口令就完全不同。
    for (let tries = 0; tries < 24; tries++) {
      const pass = await window.CloudId.derivePass(oid, createdAt, round);
      const kid = await window.CloudId.keyId(pass);
      const job = randId();
      await window.CloudApi.dispatch('bind', job, {
        meta: b64json({ aid: aid, kid: kid, round: round })
      });
      const r = await window.CloudApi.waitJob(job);
      if (r.collide) {
        log('口令编号撞了（第 ' + round + ' 轮），自动换一轮重算…');
        round++;
        continue;
      }
      state.pass = pass;
      state.kid = kid;
      state.round = round;
      lsSet('cloud_drive_round', String(round));
      $('#kidText').textContent = kid + '  · 第 ' + round + ' 轮';
      log(forceRefresh && round > 0
        ? '钥匙已换（第 ' + round + ' 轮）。老文件仍能打开，旧口令已保留在登记表里。'
        : '钥匙好了', 'ok');
      return true;
    }
    log('连续 24 轮都撞号，这不该发生。别再试了，来查一下登记表。', 'err');
    return false;
  }

  /* 专业模式才压缩。
   * 不是标准模式不能压 —— 是压缩要花时间，标准模式的定位就是"快"，
   * 为了省一点空间让人多等，不值。 */
  function procMode() {
    if (state.mode !== 'pro') return 'none';
    return ($('#optZip') && $('#optZip').checked) ? 'auto' : 'none';
  }
  function volSize() {
    if (state.mode !== 'pro') return 0;
    const b = $('#optVol');
    return (b && b.checked) ? 8 * 1024 * 1024 : 0;  // 0 = 不分卷
  }

  function b64json(o) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  }

  /* 同步登记表里属于本账号的记录，拿到别的设备刷新的轮次 */
  async function syncKeys() {
    if (state.mode !== 'simple') return;
    const aid = await blindAid(window.CloudId.ownerId());
    try {
      const job = randId();
      await window.CloudApi.dispatch('keys', job);
      await window.CloudApi.waitJob(job);
      const raw = await window.CloudApi.readRaw('keys.json');
      if (!raw) return;
      const j = JSON.parse(new TextDecoder().decode(raw));
      state.keys = (j.keys || []).filter((k) => k.aid === aid);
      if (!state.keys.length) return;
      const maxRound = Math.max.apply(null, state.keys.map((k) => k.round || 0));
      if (maxRound > state.round) {
        state.round = maxRound;
        lsSet('cloud_drive_round', String(maxRound));
        log('口令在别处刷新过，已自动跟上');
      }
    } catch (e) { /* 同步失败不影响主流程 */ }
  }

  /* 按编号找到对应的口令。
   *
   * 两种特殊情况：
   *   · 匿名文件 —— 固定口令，谁都能解（站长要能打开这些东西）；
   *   · 旧轮次的文件 —— 用上传时那一轮的口令解，不是当前这把。 */
  async function passForKid(kid, km) {
    if (km === 'anon') return window.CloudId.anonPass();
    if (state.mode !== 'simple') return state.proPass;
    if (kid === state.kid) return state.pass;
    const oid = window.CloudId.ownerId();
    const createdAt = state.account ? state.createdAt : '';
    const hit = state.keys.find((k) => k.kid === kid);
    if (hit) {
      return window.CloudId.derivePass(oid, createdAt, hit.round || 0);
    }
    // 登记表还没同步到就先本地扫一遍历史轮次
    for (let r = 0; r <= state.round; r++) {
      const p = await window.CloudId.derivePass(oid, createdAt, r);
      if ((await window.CloudId.keyId(p)) === kid) return p;
    }
    return state.pass;
  }

  /* ---------- 启动 ---------- */
  function boot() {
    // 先把全站身份层拉起来，再识别账号 ——
    // 否则 SiteIdentity 还没到，account() 读不到人，会误判成"未登录"。
    window.CloudAuth.load().then(detectAccount);

    // 页面上不再有通行证输入框：配好后端之后就不需要它了。
    // 这里只读历史遗留值，保证之前存过的会话还能用。
    state.token = localStorage.getItem(window.CloudCfg.tokenKey) || '';

    initTheme();
    initMode();

    $('#toLogin').addEventListener('click', () => { window.CloudAuth.goLogin('index.html'); });

    $('#logout').addEventListener('click', async () => {
      if (!confirm('退出登录？\n\n已存的文件不受影响，但本页会停止使用你的账号派生口令，\n直到你再次登录。')) return;
      try {
        await window.CloudAuth.logout();
        log('已退出', 'ok');
      } catch (e) {
        log('退出时出错：' + e.message, 'err');
      }
      state.account = null; state.pass = ''; state.kid = ''; state.keys = [];
      $('#kidText').textContent = '（未生成）';
      detectAccount();
    });

    $('#recheck').addEventListener('click', async () => {
      if (await detectAccount() && state.mode === 'simple') {
        state.createdAt = '';
        ensureKey();
      }
    });

    $('#refreshKey').addEventListener('click', () => {
      if (!confirm('换一把新钥匙？\n\n老文件还能打开，但如果之后清了缓存、或换电脑又登不上账号，老文件就打不开了。\n\n只在怀疑钥匙泄露时才换。')) return;
      ensureKey(true);
    });

    $('#pass').addEventListener('input', () => {
      state.proPass = $('#pass').value;
      if (state.mode === 'pro') state.pass = state.proPass;
    });

    const optVol = $('#optVol');
    if (optVol) optVol.addEventListener('change', () => {
      if (optVol.checked && !confirm('切成小块存？\n\n好处是某一块没传好可以只补那一块。\n但少任何一块，整个文件都打不开。\n\n小文件不建议勾，会变慢。')) {
        optVol.checked = false;
      }
    });

    $('#btnManifest').addEventListener('click', exportManifest);
    $('#btnExport').addEventListener('click', exportZip);
    $('#btnVerify').addEventListener('click', async () => {
      if (!state.files.length) { log('目录是空的', 'err'); return; }
      for (const f of state.files) {
        if (f.volN > 1 && f.vol !== 0) continue;
        let nm = f.id;
        try { nm = await window.CloudCrypto.decryptText(f.name, state.pass); } catch (e) {}
        const pass = await passForKid(f.kid || state.kid, f.km);
        await verifyOne(f.vid || f.id, nm, f.fp || '', pass);
      }
    });

    $('#pick').addEventListener('change', () => renderPicked());
    $('#upload').addEventListener('click', doUpload);
    $('#refresh').addEventListener('click', loadList);

    detectAccount();
    if (state.mode === 'simple') ensureKey();
    log('准备好了。');
  }

  /* 存一份密文。分卷时切成若干卷分别上传 ——
   * 每卷一个 job，单卷失败只重传那一卷。
   * 返回最后一卷的回执。 */
  async function storeSealed(sealed, id, metaBase, onVol) {
    const vs = volSize();
    const vols = vs > 0 ? window.CloudPro.split(sealed, vs) : [sealed];
    const vid = vols.length > 1 ? id : '';
    if (vols.length > 1) log('  切成 ' + vols.length + ' 小块');

    let last = null;
    for (let vi = 0; vi < vols.length; vi++) {
      const vjob = randId();
      const entryId = vols.length > 1 ? (id + '#' + vi) : id;
      const meta = Object.assign({}, metaBase, {
        name: await window.CloudCrypto.encryptText(
          vols.length > 1
            ? (metaBase._plain + ' [' + (vi + 1) + '/' + vols.length + ']')
            : metaBase._plain,
          state.pass),
        vid: vid, vol: vi, volN: vols.length,
        // 指纹只在第 0 卷记 —— 分卷后单卷算不出整份的指纹
        fp: vi === 0 ? metaBase.fp : ''
      });
      delete meta._plain;

      if (window.CloudWorker.on()) {
        const r = await window.CloudWorker.put(window.CloudId.ownerId(), entryId, meta, vols[vi]);
        last = { store: r.store || 'git', cipher: r.cipher };
      } else {
        const b64 = await window.CloudApi.blobToB64(vols[vi], (done, total) => {
          if (done === total) log('  编码完成');
        });
        await window.CloudApi.write(window.CloudCfg.inbox + '/' + vjob + '.bin', b64, '暂存 ' + vjob);
        await window.CloudApi.dispatch('put', vjob, { id: entryId, meta: b64json(meta) });
        last = await window.CloudApi.waitJob(vjob, (waited) => {
          if (waited % 15000 < 3000) log('  已等 ' + Math.round(waited / 1000) + ' 秒');
        });
      }
      if (onVol) onVol(vi + 1, vols.length);
    }
    return { r: last, vols: vols.length };
  }

  /* ---------- 专业档开关 ---------- */
  function verifyOn() {
    if (state.mode !== 'pro') return false;
    const b = $('#optVerify');
    return !!(b && b.checked);
  }

  /* 下载并解密一个文件（含分卷拼回） */
  async function fetchPlain(rec) {
    const pass = await passForKid((rec && rec.kid) || state.kid, rec && rec.km);
    let buf;
    const volN = (rec && rec.volN) || 1;
    if (volN > 1) {
      // 分卷：按序把所有卷拉回来拼成一整份密文
      log('  分块文件，取 ' + volN + ' 块…');
      const parts = [];
      for (let i = 0; i < volN; i++) {
        const vid = (rec.vid || rec.id.replace(/#\d+$/, '')) + '#' + i;
        parts.push(await fetchRaw((rec.vid || rec.id.replace(/#\d+$/, '')) + '-' + i, vid, rec));
      }
      const all = new Uint8Array(parts.reduce((a, x) => a + x.byteLength, 0));
      let p = 0;
      for (const x of parts) { all.set(new Uint8Array(x), p); p += x.byteLength; }
      buf = all.buffer;
    } else {
      buf = await fetchRaw(rec.id, rec.id, rec);
    }
    return window.CloudCrypto.decryptBuffer(buf, pass);
  }

  /* 从当前通道拿一卷的原始密文 */
  async function fetchRaw(id, volId, rec) {
    if (window.CloudWorker.on()) {
      return window.CloudWorker.get((rec && rec.oid) || window.CloudId.ownerId(), volId);
    }
    const job = randId();
    await window.CloudApi.dispatch('get', job, {
      id: volId,
      meta: b64json({ oid: (rec && rec.oid) || window.CloudId.ownerId() })
    });
    const r = await window.CloudApi.waitJob(job, null, 15 * 60 * 1000);
    if (r.channel === 'release') {
      const resp = await fetch(r.url);
      if (!resp.ok) throw new Error('直链下载失败：HTTP ' + resp.status);
      return resp.arrayBuffer();
    }
    const raw = await window.CloudApi.readRaw(r.path);
    if (!raw) throw new Error('暂存区里读不到回传文件');
    await window.CloudApi.remove(r.path, '清理下载暂存').catch(() => {});
    return raw;
  }

  /* 校验：重新解密一遍算指纹，和记下的比对。
     这是真校验 —— 只看大小对不对没意义，内容坏了大小可以不变。 */
  async function verifyOne(id, name, wantFp, pass) {
    try {
      log('  校验中：' + name);
      const rec = state.files.find((x) => x.id === id || x.vid === id) || { id: id };
      const plain = await fetchPlain(rec);
      const got = await window.CloudCrypto.fingerprint(plain, pass);
      if (got === wantFp) log('  校验通过：' + name, 'ok');
      else log('  校验不一致！' + name + '（内容可能被改动过）', 'err');
    } catch (e) {
      log('  校验失败：' + name + ' —— ' + e.message, 'err');
    }
  }

  /* 导出校验清单：把当前目录的指纹写成文本文件 */
  async function exportManifest() {
    if (!state.files.length) { log('目录是空的，没什么可导出', 'err'); return; }
    const rows = [];
    for (const f of state.files) {
      if (f.volN > 1 && f.vol !== 0) continue;   // 分卷只列第 0 卷那一条
      let nm = f.id;
      try { nm = await window.CloudCrypto.decryptText(f.name, state.pass); } catch (e) {}
      rows.push({ fp: f.fp || '', size: f.size || 0, name: nm });
    }
    const text = window.CloudPro.manifestText(rows);
    save(new Blob([text], { type: 'text/plain;charset=utf-8' }), '校验清单.txt');
    log('校验清单已导出（' + rows.length + ' 条）', 'ok');
  }

  /* 批量导出：逐个解密，打包成 zip */
  async function exportZip() {
    const picked = state.files.filter((f) => state.picked.has(f.id || f.vid));
    const list = picked.length ? picked : state.files.filter((f) => !(f.volN > 1 && f.vol !== 0));
    if (!list.length) { log('没有可导出的文件', 'err'); return; }
    const btn = $('#btnExport');
    btn.disabled = true;
    const entries = [];
    let bad = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      let nm = f.id;
      try { nm = await window.CloudCrypto.decryptText(f.name, state.pass); } catch (e) {}
      log('  打包 ' + (i + 1) + '/' + list.length + '：' + nm);
      try {
        entries.push({ name: nm, blob: await fetchPlain(f) });
      } catch (e) {
        bad++; log('  跳过：' + nm + ' —— ' + e.message, 'err');
      }
    }
    if (!entries.length) { btn.disabled = false; return; }
    const zip = await window.CloudPro.zipStore(entries);
    save(zip, '导出.zip');
    log('已打包 ' + entries.length + ' 个文件' + (bad ? '，' + bad + ' 个失败' : ''), 'ok');
    btn.disabled = false;
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ---------- 上传 ---------- */
  const MAX_FILE = 2 * 1024 * 1024 * 1024;   // 单文件 2GB

  /* 选完就把话说清楚：多大、超不超限。
   * 别等传了半天才失败 —— 大文件传到一半才报错最浪费时间。 */
  function renderPicked() {
    const fs = Array.from($('#pick').files || []);
    const box = $('#picked');
    if (!fs.length) { box.innerHTML = '<span class="dim">还没选文件</span>'; return; }

    const total = fs.reduce((a, f) => a + f.size, 0);
    const over = fs.filter((f) => f.size > MAX_FILE);
    let html = fs.map((f) => {
      const bad = f.size > MAX_FILE ? ' style="color:var(--danger)"' : '';
      return '<span class="chip"' + bad + '>' + esc(f.name) + ' · ' + fmt(f.size) + '</span>';
    }).join('');
    html += '<div class="dim" style="margin-top:6px">共 ' + fs.length + ' 个，' + fmt(total) + '</div>';
    if (over.length) {
      html += '<div class="dim" style="color:var(--danger);margin-top:4px">' +
        over.length + ' 个超过 2GB，传不上去</div>';
    }
    box.innerHTML = html;
  }

  async function doUpload() {
    if (window.CloudWorker.on()) return doUploadW();
    if (!state.token) { log('还没接上后端，暂时用不了。', 'err'); return; }
    if (!state.pass) {
      if (state.mode === 'pro') { log('先填口令', 'err'); return; }
      if (!await ensureKey()) return;
    }
    const fs = Array.from($('#pick').files || []);
    if (!fs.length) { log('先选文件', 'err'); return; }
    // 只提示一次。每次上传都拦一下太烦，而风险已经说过了。
    if (window.CloudId.isAnon() && !state.anonWarned) {
      if (!confirm('没登录，站长能看到你传的东西。\n\n要保密就先登录。继续吗？')) return;
      state.anonWarned = true;
    }
    $('#upload').disabled = true;

    // 先取一次目录，拿已有指纹做防重
    let known = [];
    try { await loadList(true); known = state.files.map((f) => f.fp || ''); } catch (e) {}

    for (const f of fs) {
      const id = randId();
      if (f.size > MAX_FILE) {
        log('跳过：' + f.name + '（超过 2GB，传不上去）', 'err');
        continue;
      }
      try {
        log('加密中：' + f.name);
        const enc = await window.CloudCrypto.encryptBlob(f, state.pass, procMode());
        const sealed = enc.blob;
        log('  密文 ' + fmt(sealed.size) + '（明文 ' + fmt(f.size) +
            (enc.saved > 0 ? '，压缩省了 ' + fmt(enc.saved) : '') + '）');

        const fp = await window.CloudCrypto.fingerprint(f, state.pass);
        if (known.indexOf(fp) >= 0) {
          log('跳过：' + f.name + '（存储里已经有完全一样的内容了）', 'err');
          continue;
        }
        known.push(fp);

        const out = await storeSealed(sealed, id, {
          _plain: f.name,
          size: f.size,
          km: window.CloudId.isAnon() ? 'anon' : state.mode,
          kid: state.kid,
          fp: fp,
          proc: enc.proc,
          oid: window.CloudId.ownerId()
        }, (i, n) => { if (n > 1) log('  第 ' + i + '/' + n + ' 块已存入'); });

        if (out.r && out.r.dup) {
          log('跳过：' + f.name + '（存储里已经有完全一样的内容，服务端拦下了）', 'err');
        } else {
          log('已存入：' + f.name + (out.vols > 1 ? '（' + out.vols + ' 小块）' : ''), 'ok');
        }
        if (verifyOn()) await verifyOne(id, f.name, fp, state.pass);
      } catch (e) {
        log('失败：' + f.name + ' —— ' + e.message, 'err');
      }
    }

    $('#upload').disabled = false;
    $('#pick').value = '';
    renderPicked();
    loadList();
  }

  /* ---------- 列目录 ---------- */
  async function loadList(quiet) {
    if (window.CloudWorker.on()) return loadListW(quiet);
    if (!state.token) { if (!quiet) log('还没接上后端，暂时用不了。', 'err'); return; }
    if (!quiet) $('#refresh').disabled = true;
    try {
      await syncKeys();
      const job = randId();
      await window.CloudApi.dispatch('list', job);
      await window.CloudApi.waitJob(job);
      const raw = await window.CloudApi.readRaw('index.json');
      if (!raw) { state.files = []; renderList(); if (!quiet) log('存储是空的'); return; }
      const idx = JSON.parse(new TextDecoder().decode(raw));
      state.files = idx.files || [];
      renderList();
      if (!quiet) log('目录已刷新，共 ' + state.files.length + ' 个文件');
    } catch (e) {
      if (!quiet) log('列目录失败：' + e.message, 'err');
    } finally {
      if (!quiet) $('#refresh').disabled = false;
    }
  }

  /* ---------- 后端通道 ----------
   * 走这条路时页面不需要任何令牌 —— 令牌在后端手里。
   * 逻辑和直连 GitHub 那条完全一致，只是不用等 Actions 跑一趟，快得多。 */
  async function loadListW(quiet) {
    try {
      const r = await window.CloudWorker.list(window.CloudId.ownerId());
      state.files = r.files || [];
      renderList();
      if (!quiet) log('目录已刷新，共 ' + state.files.length + ' 个文件');
    } catch (e) { if (!quiet) log('列目录失败：' + e.message, 'err'); }
  }

  async function doUploadW() {
    if (!state.pass) { if (!await ensureKey()) return; }
    const fs = Array.from($('#pick').files || []);
    if (!fs.length) { log('先选文件', 'err'); return; }
    // 只提示一次。每次上传都拦一下太烦，而风险已经说过了。
    if (window.CloudId.isAnon() && !state.anonWarned) {
      if (!confirm('没登录，站长能看到你传的东西。\n\n要保密就先登录。继续吗？')) return;
      state.anonWarned = true;
    }
    $('#upload').disabled = true;
    const oid = window.CloudId.ownerId();

    let known = [];
    try { await loadListW(true); known = state.files.map((f) => f.fp || ''); } catch (e) {}

    for (const f of fs) {
      if (f.size > MAX_FILE) { log('跳过：' + f.name + '（超过 2GB，传不上去）', 'err'); continue; }
      try {
        const id = randId();
        log('加密中：' + f.name);
        const enc = await window.CloudCrypto.encryptBlob(f, state.pass, procMode());
        const sealed = enc.blob;
        const fp = await window.CloudCrypto.fingerprint(f, state.pass);
        if (known.indexOf(fp) >= 0) { log('跳过：' + f.name + '（已经有了）', 'err'); continue; }
        known.push(fp);

        const out = await storeSealed(sealed, id, {
          _plain: f.name,
          size: f.size,
          km: window.CloudId.isAnon() ? 'anon' : state.mode,
          kid: state.kid,
          fp: fp,
          proc: enc.proc,
          oid: window.CloudId.ownerId()
        }, (i, n) => { if (n > 1) log('  第 ' + i + '/' + n + ' 块已存入'); });

        log('已存入：' + f.name + (out.vols > 1 ? '（' + out.vols + ' 小块）' : '') +
            '（密文 ' + fmt(sealed.size) + '）', 'ok');
        if (verifyOn()) await verifyOne(id, f.name, fp, state.pass);
      } catch (e) {
        log('失败：' + e.message, 'err');
      }
    }

    $('#upload').disabled = false;
    $('#pick').value = '';
    renderPicked();
    loadListW();
  }

  async function doDownloadW(id) {
    const rec = state.files.find((x) => x.id === id);
    try {
      const pass = await passForKid((rec && rec.kid) || state.kid, rec && rec.km);
      const buf = await window.CloudWorker.get((rec && rec.oid) || window.CloudId.ownerId(), id);
      log('解密中…');
      const plain = await window.CloudCrypto.decryptBuffer(buf, pass);
      let name = 'file-' + id;
      if (rec) { try { name = window.CloudCrypto.decryptText(rec.name, pass); } catch (e) {} }
      const url = URL.createObjectURL(plain);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      log('已下载：' + name + '（' + fmt(plain.size) + '）', 'ok');
    } catch (e) {
      log('下载失败：' + e.message, 'err');
    }
  }

  async function doRemoveW(id) {
    const rec = state.files.find((x) => x.id === id);
    let nm = id;
    if (rec) { try { nm = window.CloudCrypto.decryptText(rec.name, await passForKid(rec.kid || state.kid, rec.km)); } catch (e) {} }
    if (!confirm('删除「' + nm + '」？删掉之后没有任何找回的办法。')) return;
    try {
      await window.CloudWorker.del((rec && rec.oid) || window.CloudId.ownerId(), id);
      log('已删除：' + nm, 'ok');
      loadListW();
    } catch (e) { log('删除失败：' + e.message, 'err'); }
  }

  function renderList() {
    const box = $('#list');
    if (!state.files.length) {
      box.innerHTML = '<div class="dim">这里还空着。上面选个文件传上来，再点「刷新」看看。</div>';
      return;
    }
    // 分卷文件只显示代表那一条（第 0 卷），否则一个文件会占好几行
    const rows = state.files.filter((f) => !(f.volN > 1 && f.vol !== 0));
    // 分卷只显示代表那一条（第 0 卷），否则一个文件会占好几行
    box.innerHTML = rows.map((f) => {
      let nm = '（钥匙不对或已损坏）';
      try { nm = state.pass ? window.CloudCrypto.decryptText(f.name, state.pass) : '🔒 加密文件名'; } catch (e) {}
      const tag = f.km === 'pro' ? '<span class="kid">专业档</span>' : '';
      const vol = f.volN > 1 ? '<span class="kid">' + f.volN + ' 小块</span>' : '';
      const key = f.vid || f.id;
      const chk = state.mode === 'pro'
        ? '<input type="checkbox" class="pk"' + (state.picked.has(key) ? ' checked' : '') + '>'
        : '';
      return '<div class="row" data-id="' + esc(f.id) + '" data-key="' + esc(key) + '">' +
        '<span class="nm">' + chk + ' ' + esc(nm) + ' ' + tag + ' ' + vol + '</span>' +
        '<span class="sz">' + fmt(f.size || 0) + '</span>' +
        '<span class="at">' + esc((f.at || '').slice(0, 10)) + '</span>' +
        '<button class="dl">下载</button>' +
        '<button class="rm">删除</button>' +
        '</div>';
    }).join('');
    box.querySelectorAll('.pk').forEach((c) =>
      c.addEventListener('change', () => {
        const k = c.closest('.row').dataset.key;
        c.checked ? state.picked.add(k) : state.picked.delete(k);
      })
    );
    box.querySelectorAll('.dl').forEach((b) =>
      b.addEventListener('click', () => doDownload(b.closest('.row').dataset.id))
    );
    box.querySelectorAll('.rm').forEach((b) =>
      b.addEventListener('click', () => doRemove(b.closest('.row').dataset.id))
    );
  }

  /* ---------- 下载 ---------- */
  async function doDownload(id) {
    if (window.CloudWorker.on()) return doDownloadW(id);
    if (!state.token) { log('还没接上后端，暂时用不了。', 'err'); return; }
    const rec = state.files.find((x) => x.id === id);
    try {
      // 这个文件是用哪把口令加密的？可能不是当前这把。
      const pass = await passForKid((rec && rec.kid) || state.kid, rec && rec.km);
      if (rec && rec.kid && rec.kid !== state.kid) log('这个文件是用旧口令锁的，已自动取回');

      const job = randId();
      log('请 Actions 取文件…');
      await window.CloudApi.dispatch('get', job, {
        id: id,
        meta: b64json({ oid: (rec && rec.oid) || window.CloudId.ownerId() })
      });
      const r = await window.CloudApi.waitJob(job, null, 15 * 60 * 1000);

      let sealedBuf;
      if (r.channel === 'release') {
        log('大文件，走直链下载…');
        const resp = await fetch(r.url);
        if (!resp.ok) throw new Error('直链下载失败：HTTP ' + resp.status);
        sealedBuf = await resp.arrayBuffer();
      } else {
        const raw = await window.CloudApi.readRaw(r.path);
        if (!raw) throw new Error('暂存区里读不到回传文件');
        sealedBuf = raw;
      }

      log('解密中…');
      const plain = await window.CloudCrypto.decryptBuffer(sealedBuf, pass);

      let name = 'file-' + id;
      if (rec) { try { name = window.CloudCrypto.decryptText(rec.name, pass); } catch (e) {} }

      const url = URL.createObjectURL(plain);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      log('已下载：' + name + '（' + fmt(plain.size) + '）', 'ok');

      if (r.channel === 'git') await window.CloudApi.remove(r.path, '清理下载暂存').catch(() => {});
    } catch (e) {
      log('下载失败：' + e.message, 'err');
    }
  }

  /* ---------- 删除 ---------- */
  async function doRemove(id) {
    if (window.CloudWorker.on()) return doRemoveW(id);
    const rec = state.files.find((x) => x.id === id);
    // 分卷：连带删掉所有卷，不然会留下没人能打开的残卷
    if (rec && rec.volN > 1 && rec.vid) {
      const all = state.files.filter((x) => x.vid === rec.vid);
      for (const v of all) await removeOne(v);
      loadList();
      return;
    }
    let nm = id;
    if (rec) { try { nm = window.CloudCrypto.decryptText(rec.name, await passForKid(rec.kid || state.kid, rec.km)); } catch (e) {} }
  }
  async function removeOne(rec) {
    const id = rec.id;
    let nm = id;
    try { nm = window.CloudCrypto.decryptText(rec.name, await passForKid(rec.kid || state.kid, rec.km)); } catch (e) {}
    if (state._noConfirm !== true && !confirm('删除「' + nm + '」？删掉之后没有任何找回的办法。')) return false;
    try {
      const job = randId();
      await window.CloudApi.dispatch('del', job, {
        id: id,
        meta: b64json({ oid: (rec && rec.oid) || window.CloudId.ownerId() })
      });
      await window.CloudApi.waitJob(job);
      log('已删除：' + nm, 'ok');
      return true;
    } catch (e) {
      log('删除失败：' + e.message, 'err');
      return false;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
