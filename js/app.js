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
      simple: '口令自动算好，不用记，换电脑也在。',
      pro: '口令自己定，忘了就打不开了。'
    };
    function paint() {
      const anon = window.CloudId.isAnon();
      seg.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.mode === state.mode)
      );
      // 匿名时锁死：只有那一把固定口令，给不了选择。
      // 给了选择就是骗人 —— 选了专业模式，站长就打不开你交上去的东西了。
      $('#simpleBox').style.display = state.mode === 'simple' ? '' : 'none';
      $('#proBox').style.display = state.mode === 'pro' ? '' : 'none';
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
    const need = $('#needLogin');
    if (!a) {
      // 未登录也能用：归到本机的匿名 id 下，照样能传能取
      $('#whoNick').textContent = '未登录 · 匿名使用';
      $('#whoSrc').textContent = '只认这台浏览器，换电脑就找不回了';
      $('#logout').style.display = 'none';
      $('#toLogin').style.display = '';
      // 匿名不是"功能缺失"，是"另一种约定"——必须把代价摆在眼前
      need.style.display = '';
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
    if (!state.token && !window.CloudWorker.on()) { log('先填访问令牌', 'err'); return false; }
    await detectAccount();

    // 匿名模式只有一把写死的口令，没有"算"这一过程，也不接受刷新。
    // 刷新口令在这里是无意义的：换了它，站长就打不开你交上去的东西了。
    if (window.CloudId.isAnon()) {
      state.pass = window.CloudId.anonPass();
      state.kid = await window.CloudId.keyId(state.pass);
      state.round = 0;
      $('#kidText').textContent = '匿名固定口令（不可改）';
      log('匿名模式：用固定口令加密，站长能打开你上传的东西。', 'ok');
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
        ? '口令已刷新（第 ' + round + ' 轮）。老文件仍能打开，旧口令已保留在登记表里。'
        : '口令就位', 'ok');
      return true;
    }
    log('连续 24 轮都撞号，这不该发生。别再试了，来查一下登记表。', 'err');
    return false;
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
    state.token = localStorage.getItem(window.CloudCfg.tokenKey) || '';
    $('#token').value = state.token;
    $('#saveToken').addEventListener('click', () => {
      window.CloudApi.setToken($('#token').value);
      state.token = window.CloudApi.token();
      log(state.token ? '令牌已存到本机浏览器' : '已清空本机令牌', 'ok');
    });

    initTheme();
    initMode();

    $('#toLogin').addEventListener('click', () => { location.href = 'login.html?back=1'; });

    $('#logout').addEventListener('click', async () => {
      if (!confirm('退出登录？\n\n已存的文件不受影响，但本页会停止使用你的账号派生口令，\n直到你再次登录。')) return;
      try {
        const r = await window.CloudAuth.logout();
        log(r.shared
          ? '已退出本页（登录态是从 Chat 沿用来的，Chat 那边的会话仍在；要真正退出请到 Chat 里操作）'
          : '已退出', 'ok');
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
      if (!confirm('刷新口令？\n\n你会得到一把全新的口令。老文件仍能打开（旧口令会保留），\n但如果你清了浏览器数据、或换设备登不上原账号，老文件就报废了。\n\n只在怀疑泄露时刷新。')) return;
      ensureKey(true);
    });

    $('#pass').addEventListener('input', () => {
      state.proPass = $('#pass').value;
      if (state.mode === 'pro') state.pass = state.proPass;
    });

    $('#pick').addEventListener('change', () => renderPicked());
    $('#upload').addEventListener('click', doUpload);
    $('#refresh').addEventListener('click', loadList);

    detectAccount();
    if (state.mode === 'simple') ensureKey();
    log('填好令牌就能用了。');
  }

  /* ---------- 上传 ---------- */
  function renderPicked() {
    const fs = Array.from($('#pick').files || []);
    $('#picked').innerHTML = fs.length
      ? fs.map((f) => '<span class="chip">' + esc(f.name) + ' · ' + fmt(f.size) + '</span>').join('')
      : '<span class="dim">还没选文件</span>';
  }

  async function doUpload() {
    if (window.CloudWorker.on()) return doUploadW();
    if (!state.token) { log('先填访问令牌', 'err'); return; }
    if (!state.pass) {
      if (state.mode === 'pro') { log('先填口令', 'err'); return; }
      if (!await ensureKey()) return;
    }
    const fs = Array.from($('#pick').files || []);
    if (!fs.length) { log('先选文件', 'err'); return; }
    $('#upload').disabled = true;

    // 先取一次目录，拿已有指纹做防重
    let known = [];
    try { await loadList(true); known = state.files.map((f) => f.fp || ''); } catch (e) {}

    for (const f of fs) {
      const id = randId();
      try {
        log('加密中：' + f.name);
        const sealed = await window.CloudCrypto.encryptBlob(f, state.pass);

        const fp = await window.CloudCrypto.fingerprint(f, state.pass);
        if (known.indexOf(fp) >= 0) {
          log('跳过：' + f.name + '（存储里已经有完全一样的内容了）', 'err');
          continue;
        }
        known.push(fp);

        log('  密文 ' + fmt(sealed.size) + '（明文 ' + fmt(f.size) + '）');
        const job = randId();
        const b64 = await window.CloudApi.blobToB64(sealed, (done, total) => {
          if (done % (12 * 1024 * 1024) < 3 * 1024 * 1024 || done === total) {
            log('  编码 ' + Math.round((done / total) * 100) + '%');
          }
        });

        log('写入公开暂存区…');
        await window.CloudApi.write(window.CloudCfg.inbox + '/' + job + '.bin', b64, '暂存 ' + job);

        log('通知 Actions 搬运…');
        await window.CloudApi.dispatch('put', job, {
          id: id,
          meta: b64json({
            name: await window.CloudCrypto.encryptText(f.name, state.pass),
            size: f.size,
            km: window.CloudId.isAnon() ? 'anon' : state.mode,
            kid: state.kid,
            fp: fp,
            oid: window.CloudId.ownerId()
          })
        });

        log('等搬运回执…');
        const r = await window.CloudApi.waitJob(job, (waited) => {
          if (waited % 15000 < 3000) log('  已等 ' + Math.round(waited / 1000) + ' 秒');
        });
        if (r.dup) {
          log('跳过：' + f.name + '（存储里已经有完全一样的内容，服务端拦下了）', 'err');
        } else {
          log('已存入：' + f.name + '（' + r.store + ' 通道，密文 ' + fmt(r.cipher) + '）', 'ok');
        }
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
    if (!state.token) { if (!quiet) log('先填令牌', 'err'); return; }
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
    $('#upload').disabled = true;
    const oid = window.CloudId.ownerId();

    let known = [];
    try { await loadListW(true); known = state.files.map((f) => f.fp || ''); } catch (e) {}

    for (const f of fs) {
      try {
        log('加密中：' + f.name);
        const sealed = await window.CloudCrypto.encryptBlob(f, state.pass);
        const fp = await window.CloudCrypto.fingerprint(f, state.pass);
        if (known.indexOf(fp) >= 0) { log('跳过：' + f.name + '（已经有了）', 'err'); continue; }
        known.push(fp);

        const r = await window.CloudWorker.put(oid, randId(), {
          name: await window.CloudCrypto.encryptText(f.name, state.pass),
          size: f.size,
          km: window.CloudId.isAnon() ? 'anon' : state.mode,
          kid: state.kid,
          fp: fp
        }, sealed);
        log('已存入：' + f.name + '（密文 ' + fmt(r.cipher) + '）', 'ok');
      } catch (e) {
        log('失败：' + f.name + ' —— ' + e.message, 'err');
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
      box.innerHTML = '<div class="dim">还没有文件</div>';
      return;
    }
    box.innerHTML = state.files.map((f) => {
      let shown = '（口令不对或已损坏）';
      try { shown = state.pass ? window.CloudCrypto.decryptText(f.name, state.pass) : '🔒 加密文件名'; } catch (e) {}
      const tag = f.km === 'pro' ? '<span class="kid">专业</span>' : '';
      return '<div class="row" data-id="' + f.id + '">' +
        '<span class="nm">' + esc(shown) + ' ' + tag + '</span>' +
        '<span class="sz">' + fmt(f.size || 0) + '</span>' +
        '<span class="at">' + (f.at || '').slice(0, 10) + '</span>' +
        '<button class="dl">下载</button>' +
        '<button class="rm">删除</button>' +
        '</div>';
    }).join('');
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
    if (!state.token) { log('先填令牌', 'err'); return; }
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
    let nm = id;
    if (rec) { try { nm = window.CloudCrypto.decryptText(rec.name, await passForKid(rec.kid || state.kid, rec.km)); } catch (e) {} }
    if (!confirm('删除「' + nm + '」？删掉之后没有任何找回的办法。')) return;
    try {
      const job = randId();
      await window.CloudApi.dispatch('del', job, {
        id: id,
        meta: b64json({ oid: (rec && rec.oid) || window.CloudId.ownerId() })
      });
      await window.CloudApi.waitJob(job);
      log('已删除：' + nm, 'ok');
      loadList();
    } catch (e) {
      log('删除失败：' + e.message, 'err');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
