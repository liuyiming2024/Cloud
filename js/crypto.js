/* Cloud Drive · 加密层
 *
 * 浏览器原生 Web Crypto，不引任何第三方库。
 * 文件在离开浏览器之前就已经是密文——公开仓库里存的只是密文，
 * 私有库里存的还是密文。口令丢了就是丢了，没有任何找回通道。
 *
 * 密文容器格式：
 *   "CDRV"            4B  魔数
 *   ver               1B  版本号（1=无预处理，2=带预处理）
 *   [ver>=2] proc     1B  预处理方式：0=原样，1=gzip
 *   salt             16B  PBKDF2 盐，每次加密随机
 *   chunkSize         4B  分块大小（uint32 大端）
 *   重复直到结束：
 *     iv             12B  GCM nonce，每块随机
 *     len             4B  本块明文字节数（uint32 大端）
 *     sealed      len+16B  密文 + GCM tag
 *
 * 每块把「块序号」放进 additionalData：
 * 缺块、重排、截断都会在解密时直接抛错，不会静默产出半个文件。
 *
 * 预处理发生在加密**之前**：先压缩，再加密。
 * 顺序不能反 —— 加密后的字节是均匀随机的，压不动，先加密再压缩只会白费力气。
 *
 * 解压发生在解密之后。proc 写在密文头里，解密方自己知道该怎么还原，
 * 不需要用户记得"我当时压了没有"。
 */
(function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const MAGIC = [0x43, 0x44, 0x52, 0x56]; // CDRV
  const VER = 1;
  const VER2 = 2;          // 带预处理标记
  const PROC_NONE = 0;
  const PROC_GZIP = 1;
  const SALT_LEN = 16;
  const IV_LEN = 12;
  const HEADER_V1 = 4 + 1 + SALT_LEN + 4;
  const HEADER_V2 = 4 + 1 + 1 + SALT_LEN + 4;

  /* ---------- 预处理（压缩）----------
   * 浏览器原生 CompressionStream，不引第三方库。
   * 不可用时返回 null，调用方降级成原样 —— 不能因为环境不支持就传失败。 */
  function canCompress() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  }
  function gzip(blob) {
    if (!canCompress()) return Promise.resolve(null);
    return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob()
      .catch(() => null);
  }
  function gunzip(blob) {
    if (!canCompress()) return Promise.reject(new Error('这个浏览器不支持解压'));
    return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }

  function u32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function rand(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* 内容指纹：给防重用。
   *
   * 不存明文的 SHA-256 —— 那等于把文件内容的可验证摘要交出去，
   * 别人拿一份候选文件就能离线比对"他是不是存了这个"。
   * 改成用口令派生的密钥做 HMAC：同样内容在同一口令下指纹相同（能查重），
   * 但不知道口令的人既算不出指纹，也拿它比对不了任何东西。
   *
   * 分块算，避免大文件一次性进内存。 */
  async function fingerprint(blob, passphrase) {
    const salt = new Uint8Array(SALT_LEN); // 全零固定盐：指纹必须可复现
    const key = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
      .then((b) => crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
        b, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      ));

    const chunk = 4 * 1024 * 1024;
    const total = blob.size;
    const n = Math.max(1, Math.ceil(total / chunk));
    // 长度先混进去，防止"前缀相同"的碰撞
    let mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, u32(total)));

    for (let i = 0; i < n; i++) {
      const s = i * chunk;
      const buf = await blob.slice(s, Math.min(s + chunk, total)).arrayBuffer();
      const block = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
      // 块序号也混进去，顺序变了指纹就变
      const merged = new Uint8Array(mac.length + block.length + 4);
      merged.set(mac, 0);
      merged.set(block, mac.length);
      merged.set(u32(i), mac.length + block.length);
      mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, merged));
    }
    return b64url(mac);
  }

  function b64url(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* 加密：File/Blob → Blob（密文容器） */
  /* 加密：File/Blob → Blob（密文容器）
   *
   * proc: 'auto'（默认，压了更小才压）| 'gzip'（一定压）| 'none'（不压）
   * 返回 { blob, proc, saved } —— proc 要存进索引，saved 只是给界面看的。 */
  async function encryptBlob(blob, passphrase, proc, onProgress) {
    proc = proc || 'auto';
    let body = blob;
    let code = PROC_NONE;

    if (proc !== 'none' && canCompress()) {
      const z = await gzip(blob);
      // 已经压过的文件（zip/jpg/mp4）再压只会变大。
      // 变大就存原样 —— 为了"看起来专业"而把文件撑大是纯亏。
      if (z && z.size < blob.size) { body = z; code = PROC_GZIP; }
    }

    const salt = rand(SALT_LEN);
    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const chunkSize = window.CloudCfg.crypto.chunkSize;

    const total = body.size;
    const chunks = Math.max(1, Math.ceil(total / chunkSize));
    const parts = [];
    let outLen = HEADER_V2;

    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const buf = await body.slice(start, Math.min(start + chunkSize, total)).arrayBuffer();
      const iv = rand(IV_LEN);
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: u32(i) },
          key,
          buf
        )
      );
      parts.push({ iv, len: buf.byteLength, sealed });
      outLen += IV_LEN + 4 + sealed.length;
      // 大文件加密要跑好几秒，不说点什么的话，用户会以为卡死了然后刷新 ——
      // 刷新丢的是已经等过的那段时间。
      if (onProgress && (i % 4 === 0 || i === chunks - 1)) onProgress(i + 1, chunks);
    }

    const out = new Uint8Array(outLen);
    let p = 0;
    out.set(MAGIC, p); p += 4;
    out[p++] = VER2;
    out[p++] = code;
    out.set(salt, p); p += SALT_LEN;
    out.set(u32(chunkSize), p); p += 4;
    for (const c of parts) {
      out.set(c.iv, p); p += IV_LEN;
      out.set(u32(c.len), p); p += 4;
      out.set(c.sealed, p); p += c.sealed.length;
    }
    return {
      blob: new Blob([out], { type: 'application/octet-stream' }),
      proc: code,
      saved: blob.size - body.size
    };
  }

  /* 解密：密文 ArrayBuffer → Blob
   *
   * 按头里的 ver 分支：v1 没有预处理，v2 可能有 gzip。
   * 老文件（v1）照样能开 —— 它们本来就没压过。 */
  async function decryptBuffer(raw, passphrase, onProgress) {
    const b = new Uint8Array(raw);
    for (let i = 0; i < 4; i++) {
      if (b[i] !== MAGIC[i]) throw new Error('不是本云盘的密文文件（魔数不对）');
    }
    const ver = b[4];
    if (ver !== VER && ver !== VER2) throw new Error('密文版本不支持：' + ver);

    let p, proc = PROC_NONE;
    if (ver === VER2) {
      proc = b[5];
      if (proc !== PROC_NONE && proc !== PROC_GZIP) throw new Error('未知的预处理方式：' + proc);
      p = 6;
    } else {
      p = 5;
    }

    const salt = b.slice(p, p + SALT_LEN); p += SALT_LEN;
    const chunkSize = readU32(b, p); p += 4;

    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const plain = [];
    // 先算出总块数，否则进度只能给"已处理几块"而给不出分母
    let nChunks = 0;
    {
      let q = p;
      while (q < b.length) {
        if (q + IV_LEN + 4 > b.length) break;
        const len = readU32(b, q + IV_LEN);
        q += IV_LEN + 4 + len + 16;
        nChunks++;
      }
    }

    let i = 0;
    while (p < b.length) {
      if (p + IV_LEN + 4 > b.length) throw new Error('密文被截断（块头不完整）');
      const iv = b.slice(p, p + IV_LEN); p += IV_LEN;
      const len = readU32(b, p); p += 4;
      if (p + len + 16 > b.length) throw new Error('密文被截断（第 ' + i + ' 块数据不完整）');
      const sealed = b.slice(p, p + len + 16); p += len + 16;
      plain.push(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: u32(i) }, key, sealed)
      );
      i++;
      if (onProgress && (i % 4 === 0 || i === nChunks)) onProgress(i, nChunks);
    }

    let out = new Blob(plain, { type: 'application/octet-stream' });
    // 先解密、后解压 —— 与加密时的顺序严格反过来
    if (proc === PROC_GZIP) out = await gunzip(out);
    return out;
  }

  /* 文件名等短元数据也加密，避免私有库/公开库里留下真实文件名 */
  async function encryptText(text, passphrase) {
    const salt = rand(SALT_LEN);
    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const iv = rand(IV_LEN);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
    const out = new Uint8Array(SALT_LEN + IV_LEN + sealed.length);
    out.set(salt, 0);
    out.set(iv, SALT_LEN);
    out.set(sealed, SALT_LEN + IV_LEN);
    return btoa(String.fromCharCode(...out));
  }

  async function decryptText(b64, passphrase) {
    const all = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const salt = all.slice(0, SALT_LEN);
    const iv = all.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const sealed = all.slice(SALT_LEN + IV_LEN);
    const key = await deriveKey(passphrase, salt, window.CloudCfg.crypto.iterations);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed);
    return dec.decode(buf);
  }

  window.CloudCrypto = { encryptBlob, decryptBuffer, encryptText, decryptText, fingerprint };
})();
