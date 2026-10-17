/* Cloud Drive · 页面内编程接口
 *
 * 给同源的其他页面或控制台脚本用。它能做的事和界面上的按钮完全一样，不会更多。
 *
 * 边界要说清楚：
 *   · 它拿不到私有存储库的地址，也拿不到那枚高权限令牌 —— 两者只存在于
 *     Actions Secrets 里，任何前端代码都看不见。
 *   · 它读的是本机的 localStorage（同源共享），口令不跨页面传。
 *   · 专业模式的口令不会被记住，所以那种模式下要先 unlock(pass) 才能用。
 *
 * 简单模式的口令能自己算出来（账号 + 注册时间 + 轮次），所以不用 unlock。
 */
(function () {
  const P = {
    token: '',
    pass: '',        // 专业模式由 unlock() 填，简单模式自动算
    kid: '',
    ready: false,
    reason: '还没初始化',
    listeners: []
  };

  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  /* 有后端就走后端：不用等 Actions 跑一趟，也不用本地令牌。
     对 Code 那种"藏在 iframe 里当模块用"的场景尤其重要 ——
     那边一次调用卡几十秒，界面就废了。 */
  function viaWorker() { return !!(window.CloudWorker && window.CloudWorker.on()); }

  function emit() {
    P.listeners.slice().forEach((fn) => {
      try { fn({ count: -1 }); } catch (e) {}
    });
  }

  function b64json(o) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  }
  function randId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function blindAid(uid) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('aid:' + uid));
    return btoa(String.fromCharCode.apply(null, new Uint8Array(d)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
  }

  /* 把口令准备好：专业模式等 unlock，简单模式自己算 */
  async function ensure() {
    if (!viaWorker()) {
      P.token = lsGet(window.CloudCfg.tokenKey, '');
      if (!P.token) { P.ready = false; P.reason = '没有访问令牌（先在页面上填一次）'; return false; }
    }

    const acc = window.CloudId.account();
    if (!acc) {
      // 专业模式没账号也能用，但必须有口令
      if (P.pass) { P.ready = true; P.reason = null; return true; }
      P.ready = false;
      P.reason = '没识别到账号。去登录，或调 Cloud.api.unlock(口令) 走专业模式';
      return false;
    }

    if (P.pass) { P.ready = true; P.reason = null; return true; }

    // 简单模式：现算
    try {
      const createdAt = await window.CloudId.fetchCreatedAt(acc.uid);
      const round = parseInt(lsGet('cloud_drive_round', '0'), 10);
      P.pass = await window.CloudId.derivePass(acc.uid, createdAt, round);
      P.kid = await window.CloudId.keyId(P.pass);
      P.ready = true;
      P.reason = null;
      return true;
    } catch (e) {
      P.ready = false;
      P.reason = '口令算不出来：' + e.message;
      return false;
    }
  }

  const api = {
    /* 契约版本。Code 的 drive.js 靠它判断能不能用 ——
       接口一变但没 bump，那边就会调到不存在的方法，报"没有这个方法"。
       所以改接口必须跟着改这个数。 */
    version: 2,

    /* 走哪条通道：后端（快）还是 Actions（慢） */
    channel: () => (viaWorker() ? 'worker' : 'actions'),

    /* 是否可用 */
    ready: () => P.ready,
    /* 不可用时说明原因，可用时返回 null */
    reason: () => P.reason,

    /* 初始化 / 重新初始化 */
    init: () => ensure(),

    /* 专业模式：显式交出本次会话的口令。只留在内存里，不落盘。 */
    unlock: function (pass) {
      if (!pass) throw new Error('口令不能为空');
      P.pass = pass;
      P.kid = '';
      return ensure().then((ok) => {
        if (!ok) throw new Error(P.reason);
        return window.CloudId.keyId(pass).then((k) => { P.kid = k; return k; });
      });
    },

    /* 当前口令编号（单向摘要，不是口令） */
    keyId: () => P.kid || null,

    /* 目录 */
    list: async function () {
      if (!await ensure()) throw new Error(P.reason);
      if (viaWorker()) {
        const r = await window.CloudWorker.list(window.CloudId.ownerId());
        return r.files || [];
      }
      const job = randId();
      await window.CloudApi.dispatch('list', job);
      await window.CloudApi.waitJob(job);
      const raw = await window.CloudApi.readRaw('index.json');
      if (!raw) return [];
      const idx = JSON.parse(new TextDecoder().decode(raw));
      const files = idx.files || [];
      // 顺手把文件名解出来（解不开就留原样，不丢条目）
      for (const f of files) {
        try { f.plainName = await window.CloudCrypto.decryptText(f.name, P.pass); }
        catch (e) { f.plainName = null; }
      }
      return files;
    },

    /* 上传：file 是 File 或 Blob，name 可选（Blob 没有名字时要给） */
    upload: async function (file, name) {
      if (!await ensure()) throw new Error(P.reason);
      const nm = name || file.name || ('blob-' + randId());
      const id = randId();

      const sealed = await window.CloudCrypto.encryptBlob(file, P.pass);
      const fp = await window.CloudCrypto.fingerprint(file, P.pass);

      // 前端先查一次重
      const cur = await api.list().catch(() => []);
      if (cur.some((f) => f.fp === fp)) throw new Error('存储里已经有完全一样的内容了');

      if (viaWorker()) {
        await window.CloudWorker.put(window.CloudId.ownerId(), id, {
          name: await window.CloudCrypto.encryptText(nm, P.pass),
          size: file.size,
          km: window.CloudId.isAnon() ? 'anon' : (P.kid ? 'simple' : 'pro'),
          kid: P.kid,
          fp: fp
        }, sealed);
        emit();
        return id;
      }

      const job = randId();
      const b64 = await window.CloudApi.blobToB64(sealed);
      await window.CloudApi.write(window.CloudCfg.inbox + '/' + job + '.bin', b64, '暂存 ' + job);
      await window.CloudApi.dispatch('put', job, {
        id: id,
        meta: b64json({
          name: await window.CloudCrypto.encryptText(nm, P.pass),
          size: file.size,
          km: P.kid ? 'simple' : 'pro',
          kid: P.kid,
          fp: fp
        })
      });
      const r = await window.CloudApi.waitJob(job);
      if (r.dup) throw new Error('存储里已经有完全一样的内容（服务端拦下了）');
      emit();
      return id;
    },

    /* 下载：返回明文 Blob */
    download: async function (id) {
      if (!await ensure()) throw new Error(P.reason);
      if (viaWorker()) {
        return window.CloudCrypto.decryptBuffer(
          await window.CloudWorker.get(window.CloudId.ownerId(), id), P.pass);
      }
      const job = randId();
      await window.CloudApi.dispatch('get', job, { id });
      const r = await window.CloudApi.waitJob(job, null, 15 * 60 * 1000);

      let buf;
      if (r.channel === 'release') {
        const resp = await fetch(r.url);
        if (!resp.ok) throw new Error('直链下载失败：HTTP ' + resp.status);
        buf = await resp.arrayBuffer();
      } else {
        const raw = await window.CloudApi.readRaw(r.path);
        if (!raw) throw new Error('暂存区里读不到回传文件');
        buf = raw;
        await window.CloudApi.remove(r.path, '清理下载暂存').catch(() => {});
      }
      return window.CloudCrypto.decryptBuffer(buf, P.pass);
    },

    /* 删除：没有回收站 */
    remove: async function (id) {
      if (!await ensure()) throw new Error(P.reason);
      if (viaWorker()) {
        await window.CloudWorker.del(window.CloudId.ownerId(), id);
        emit();
        return true;
      }
      const job = randId();
      await window.CloudApi.dispatch('del', job, { id });
      await window.CloudApi.waitJob(job);
      emit();
      return true;
    },

    /* 容量上限 */
    limits: function () {
      return {
        gitFileMax: 100 * 1024 * 1024,
        releaseFileMax: 2 * 1024 * 1024 * 1024,
        autoSwitchAt: window.CloudCfg.bigFileHint,
        repoSoftMax: 1024 * 1024 * 1024
      };
    },

    /* 取回 api/manifest.json */
    manifest: function () {
      return fetch('api/manifest.json', { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('取不到清单：HTTP ' + r.status);
        return r.json();
      });
    },

    /* 订阅变更：上传 / 删除后触发，返回取消函数 */
    on: function (event, fn) {
      if (event !== 'change') throw new Error('目前只支持 change 事件');
      P.listeners.push(fn);
      return function () {
        const i = P.listeners.indexOf(fn);
        if (i >= 0) P.listeners.splice(i, 1);
      };
    },

    /* 账号信息（不暴露令牌） */
    who: function () {
      const a = window.CloudId.account();
      return a ? { uid: a.uid.slice(0, 8) + '…', from: a.from } : null;
    }
  };

  window.Cloud = window.Cloud || {};
  window.Cloud.api = api;

  // 页面加载完就试着就绪，让控制台上来就能用
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensure());
  } else {
    ensure();
  }
})();
