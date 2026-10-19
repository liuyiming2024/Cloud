/* Cloud Drive · 专业档附加能力
 *
 * 三样东西，都是勾选后才生效：
 *   分卷     —— 大文件切成若干卷分别存，单卷坏掉只补那一卷，也方便断点续传
 *   校验清单 —— 给存着的文件出一份指纹清单，事后能查出"有没有坏"
 *   批量导出 —— 一次把多个文件打包下载
 *
 * 为什么这些只在专业档给：
 *   它们都要额外时间（分卷要多轮上传、校验要重新解密算指纹、打包要写 zip）。
 *   标准档的定位就是快，不该为了这些让人多等。
 *
 * 不引任何第三方库。zip 是自己写的（只做 store，不压缩 ——
 * 文件内容本来就加密过了，再压一遍压不动，纯浪费时间）。
 */
(function () {
  const enc = new TextEncoder();

  /* ---------- 极简 ZIP（store 模式）----------
   * 只写必要的结构：本地头 + 数据 + 中央目录 + EOCD。
   * 不压缩，因为打包进去的已经是密文/原文，压不动。 */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  function u16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
  function u32le(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }

  /* 把文件名清成能安全放进 zip 的样子。
   *
   * 为什么必须清：文件名是上传者自己定的（加密存在索引里）。
   * 若有人把文件命名为 ../../evil.sh，而解压工具不检查路径，
   * 解压时就会写到目标目录**外面**去 —— 这就是 zip-slip。
   * 我们的压缩包是要被人下载下来解压的，这条不能赌解压工具做不做检查。
   *
   * 另外去掉盘符、绝对路径、控制字符，那些同样不该出现在压缩包里。 */
  function safeName(n) {
    let s = String(n || 'file');
    s = s.replace(/\0/g, '');                    // 空字节
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f\u007f]/g, ''); // 控制字符
    s = s.replace(/^[A-Za-z]:/, '');              // 盘符 C:
    s = s.replace(/^[/\\]+/, '');                // 开头的 / 或 \
    s = s.split(/[/\\]/).pop() || 'file';        // 只留最后一段
    s = s.replace(/^\.+$/, 'file');               // 纯点（. / ..）
    s = s.trim();
    return s || 'file';
  }

  /* 同名条目加后缀，别让解压时静默覆盖 */
  function dedupe(names) {
    const seen = new Map();
    return names.map((n) => {
      const c = seen.get(n) || 0;
      seen.set(n, c + 1);
      if (c === 0) return n;
      const dot = n.lastIndexOf('.');
      return dot > 0
        ? n.slice(0, dot) + ' (' + c + ')' + n.slice(dot)
        : n + ' (' + c + ')';
    });
  }

  /* entries: [{ name, blob }] → zip Blob。
     条目名先过 safeName + dedupe，原因见上。 */
  async function zipStore(entries, onProgress) {
    entries = entries.map((e, i) => ({ name: e.name, blob: e.blob }));
    const cleaned = dedupe(entries.map((e) => safeName(e.name)));
    entries = entries.map((e, i) => ({ name: cleaned[i], blob: e.blob }));
    const now = new Date();
    const tm = dosTime(now), dt = dosDate(now);
    const parts = [];      // 每个文件的：本地头 + 数据
    const central = [];    // 中央目录
    let offset = 0;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const nameU8 = enc.encode(e.name);
      const dataU8 = new Uint8Array(await e.blob.arrayBuffer());
      const crc = crc32(dataU8);

      // 本地文件头（30 字节固定部分）
      const lh = new Uint8Array(30 + nameU8.length);
      let p = 0;
      lh.set(u32le(0x04034b50), p); p += 4;   // 签名
      lh.set(u16(20), p); p += 2;              // 版本
      lh.set(u16(0x0800), p); p += 2;          // UTF-8 文件名标记
      lh.set(u16(0), p); p += 2;               // store
      lh.set(u16(tm), p); p += 2;
      lh.set(u16(dt), p); p += 2;
      lh.set(u32le(crc), p); p += 4;
      lh.set(u32le(dataU8.length), p); p += 4; // 压缩后大小
      lh.set(u32le(dataU8.length), p); p += 4; // 原始大小
      lh.set(u16(nameU8.length), p); p += 2;
      lh.set(u16(0), p); p += 2;               // extra
      lh.set(nameU8, p);

      parts.push(lh, dataU8);

      // 中央目录（46 字节固定部分）
      const cd = new Uint8Array(46 + nameU8.length);
      let q = 0;
      cd.set(u32le(0x02014b50), q); q += 4;
      cd.set(u16(20), q); q += 2;              // 产生者版本
      cd.set(u16(20), q); q += 2;              // 需要版本
      cd.set(u16(0x0800), q); q += 2;
      cd.set(u16(0), q); q += 2;
      cd.set(u16(tm), q); q += 2;
      cd.set(u16(dt), q); q += 2;
      cd.set(u32le(crc), q); q += 4;
      cd.set(u32le(dataU8.length), q); q += 4;
      cd.set(u32le(dataU8.length), q); q += 4;
      cd.set(u16(nameU8.length), q); q += 2;
      cd.set(u16(0), q); q += 2;               // extra
      cd.set(u16(0), q); q += 2;               // comment
      cd.set(u16(0), q); q += 2;               // 起始盘号
      cd.set(u16(0), q); q += 2;               // 内部属性
      cd.set(u32le(0), q); q += 4;             // 外部属性
      cd.set(u32le(offset), q); q += 4;        // 本地头偏移
      cd.set(nameU8, q);
      central.push(cd);

      offset += lh.length + dataU8.length;
      if (onProgress) onProgress(i + 1, entries.length);
    }

    const cdSize = central.reduce((a, x) => a + x.length, 0);

    const eocd = new Uint8Array(22);
    let r = 0;
    eocd.set(u32le(0x06054b50), r); r += 4;
    eocd.set(u16(0), r); r += 2;
    eocd.set(u16(0), r); r += 2;
    eocd.set(u16(entries.length), r); r += 2;
    eocd.set(u16(entries.length), r); r += 2;
    eocd.set(u32le(cdSize), r); r += 4;
    eocd.set(u32le(offset), r); r += 4;
    eocd.set(u16(0), r);                      // 注释长度

    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  /* ---------- 分卷 ----------
   * 把密文切成若干卷。每卷是一段独立的密文切片 ——
   * 注意：不是"每卷单独加密"。整份密文（含头部）只在第 0 卷，
   * 后续卷是纯数据切片。解密时必须按序拼回。
   *
   * 这样设计的后果要认：丢任何一卷，整份文件都解不开。
   * 分卷换来的是"单卷失败只需重传那一卷"，不是"丢几卷还能救回来"。 */
  function split(blob, volSize) {
    const n = Math.max(1, Math.ceil(blob.size / volSize));
    const vols = [];
    for (let i = 0; i < n; i++) {
      vols.push(blob.slice(i * volSize, Math.min((i + 1) * volSize, blob.size)));
    }
    return vols;
  }

  /* ---------- 校验清单 ----------
   * 列出每个文件的指纹。事后拿这份清单可以查"存着的东西有没有被动过"。
   * 指纹是用口令派生的 HMAC —— 没有口令的人拿这份清单也比对不了什么。 */
  function manifestText(rows) {
    const head = [
      '# Cloud Drive 校验清单',
      '# 指纹 = 用你的口令派生的 HMAC-SHA256（前 32 位十六进制）',
      '# 没有口令的人拿到这份清单也比对不了任何东西。',
      ''
    ];
    const body = rows.map((r) => [r.fp || '', String(r.size || 0), r.name || ''].join('  '));
    return head.concat(body).join('\n') + '\n';
  }

  window.CloudPro = {
    zipStore: zipStore,
    safeName: safeName,
    crc32: crc32,
    split: split,
    manifestText: manifestText
  };
})();
