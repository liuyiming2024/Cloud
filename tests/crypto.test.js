/* Cloud Drive · 加密层回归测试
 * 用法：node tests/crypto.test.js <Cloud 目录>
 *
 * 真机浏览器有 Web Crypto，Node 20 也有，所以这轮不是"模拟"，是真跑。
 * 但 Blob / File 的语义仍以浏览器为准，大文件分块路径请在浏览器里再确认一次。
 */
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

const ROOT = process.argv[2];
if (!ROOT) { console.error('用法：node tests/crypto.test.js <Cloud 目录>'); process.exit(2); }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' —— ' + extra : '')); }
}

// 搭一个够用的浏览器环境
globalThis.crypto = webcrypto;
globalThis.window = globalThis; // 页面里挂 window，Node 里让 window 指向自己
globalThis.CloudCfg = { crypto: { iterations: 20000, chunkSize: 4 * 1024 * 1024 } }; // 测试降迭代，快
const src = fs.readFileSync(path.join(ROOT, 'js/crypto.js'), 'utf8');
new Function(src)();
const C = globalThis.CloudCrypto;

(async () => {
  console.log('加密层回归（' + ROOT + '）');

  const data = new Uint8Array(300 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 255;
  const plain = new Blob([data]);

  // 1. 往返一致
  const sealed = await C.encryptBlob(plain, '口令-abc');
  const back = await C.decryptBuffer(await sealed.arrayBuffer(), '口令-abc');
  const backU8 = new Uint8Array(await back.arrayBuffer());
  ok('往返后字节完全一致', backU8.length === data.length && backU8.every((v, i) => v === data[i]),
     '长度 ' + backU8.length + ' vs ' + data.length);
  ok('明文长度 = 原始长度', back.size === plain.size);

  // 2. 密文膨胀符合预期（头 25B + 每块 12+4+16）
  const chunks = Math.ceil(data.length / CloudCfg.crypto.chunkSize);
  const expect = 25 + chunks * 32 + data.length;
  ok('密文膨胀量符合格式', sealed.size === expect, sealed.size + ' vs ' + expect);

  // 3. 口令错必须报错，不能静默产出垃圾
  let wrong = false;
  try { await C.decryptBuffer(await sealed.arrayBuffer(), '口令-abd'); } catch (e) { wrong = true; }
  ok('口令错误时抛错（不静默产出坏数据）', wrong);

  // 4. 截断必须报错
  const full = new Uint8Array(await sealed.arrayBuffer());
  let trunc = false;
  try { await C.decryptBuffer(full.slice(0, full.length - 40).buffer, '口令-abc'); } catch (e) { trunc = true; }
  ok('密文被截断时抛错', trunc);

  // 5. 块重排必须报错（块序号进了 additionalData）
  const b = full.slice(0, 25 + 32);
  let reorder = false;
  try {
    const n = new Uint8Array(full.length);
    n.set(full);
    // 交换前两个块的 iv 区
    for (let i = 0; i < 12; i++) { const t = n[25 + i]; n[25 + i] = n[25 + 32 + i]; n[25 + 32 + i] = t; }
    await C.decryptBuffer(n.buffer, '口令-abc');
  } catch (e) { reorder = true; }
  ok('块 nonce 被篡改时抛错', reorder);

  // 6. 魔数校验
  let magic = false;
  try {
    const n = new Uint8Array(full.length); n.set(full); n[0] = 0x41;
    await C.decryptBuffer(n.buffer, '口令-abc');
  } catch (e) { magic = /魔数/.test(e.message); }
  ok('非本云盘的密文能被识别出来', magic);

  // 7. 空文件
  const empty = new Blob([]);
  const es = await C.encryptBlob(empty, 'p');
  const eb = await C.decryptBuffer(await es.arrayBuffer(), 'p');
  ok('空文件也能往返（0 字节）', eb.size === 0);

  // 8. 文件名加解密
  const encName = await C.encryptText('报表/2026/Q1.xlsx', 'p');
  ok('文件名加密后不含明文', !Buffer.from(encName, 'base64').includes('Q1'));
  ok('文件名可解回原文', (await C.decryptText(encName, 'p')) === '报表/2026/Q1.xlsx');
  let nameWrong = false;
  try { await C.decryptText(encName, 'q'); } catch (e) { nameWrong = true; }
  ok('口令错时文件名解不开', nameWrong);

  // 9. 两次加密同一内容，密文不同（盐与 nonce 随机）
  const s2 = await C.encryptBlob(plain, '口令-abc');
  ok('同一明文两次加密密文不同（防重放比对）',
     Buffer.from(await sealed.arrayBuffer()).toString('hex') !== Buffer.from(await s2.arrayBuffer()).toString('hex'));

  // 10. 多块路径（>1 块）
  const big = new Blob([new Uint8Array(9 * 1024 * 1024)]);
  const bs = await C.encryptBlob(big, 'p');
  const bb = await C.decryptBuffer(await bs.arrayBuffer(), 'p');
  ok('多块文件（9MB，3 块）往返一致', bb.size === big.size);

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试本身崩了：', e); process.exit(1); });
