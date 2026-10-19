#!/usr/bin/env node
/* 抓"用了但从未定义"的变量名。
 *
 * 这类 bug 语法完全合法，node --check 过得去，只有真跑才会炸 ——
 * 而且只在特定分支炸（比如只有走 Worker 通道时才执行到那行）。
 * 上次就是 pageapi.js 里用了 procArg 却从没定义，任何一次 upload 都抛
 * ReferenceError，跟传什么参数无关。
 *
 * 做法很土：收集所有定义过的名字，再看哪些"像局部变量"的驼峰标识符
 * 既没被定义、也不是内置/对象键。宁可漏报，不可误报刷屏。
 *
 * 用法：node scripts/check-refs.js <Cloud目录>
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || '.';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e ? ' —— ' + e : '')); }
};

console.log('未定义变量检查');

const files = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));

/* 额外查一类：$('#xxx') 选的 id 在页面里到底存不存在。
 *
 * 这类 bug 更阴：语法对、变量也定义过，只是元素是 null。
 * 只有真的执行到那一行才炸，而且只在特定分支炸 ——
 * 之前删掉 #needLogin 元素后，detectAccount() 里还留着 need.style.display，
 * 结果"已登录"这个分支一进去就报错，而未登录分支一切正常。 */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ids = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);

for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const missing = new Set();
  for (const m of clean.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)) {
    if (!ids.has(m[1])) missing.add('#' + m[1]);
  }
  ok(f + ' 引用的页面元素都存在', missing.size === 0, [...missing].join(', '));
}

/* 已知安全：语言内置、全局、本项目命名空间、常见对象键名 */
const SAFE = new Set([
  // 全局
  'window', 'document', 'crypto', 'localStorage', 'fetch', 'Response', 'Blob', 'File',
  'URL', 'TextEncoder', 'TextDecoder', 'Uint8Array', 'Uint32Array', 'ArrayBuffer',
  'Promise', 'JSON', 'Math', 'Date', 'Error', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Set', 'Map', 'console', 'location', 'navigator', 'alert', 'confirm',
  'btoa', 'atob', 'CompressionStream', 'DecompressionStream', 'URLSearchParams',
  'process', 'require', 'globalThis', 'arguments', 'undefined', 'null', 'true', 'false',
  'global', 'module', 'exports', '__filename', '__dirname', 'this',
  // 内置函数
  'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'unescape', 'escape',
  // 本项目命名空间
  'CloudCfg', 'CloudCrypto', 'CloudId', 'CloudAuth', 'CloudApi', 'CloudWorker',
  'CloudPro', 'Cloud', 'CloudBridge', 'SiteIdentity',
  // 短局部名
  'P', 'C', 'A', 'I', 'W', 'SI', 'enc', 'dec',
  // 常被写成驼峰但其实是对象键
  'proPass', 'tokenKey', 'proIterations', 'chunkSize', 'anonPass', 'bigFileHint',
  'additionalData', 'keyId', 'gitFileMax', 'releaseFileMax', 'autoSwitchAt',
  'repoSoftMax', 'iterations', 'inbox', 'worker', 'simpleSalt',
  'uid', 'token', 'nick', 'shared', 'via', 'cryptoCfg'
]);

for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');

  const defined = new Set(SAFE);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().replace(/=[\s\S]*$/, '').replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(t)) defined.add(t);
    }
  }
  for (const m of src.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g)) defined.add(m[1]);

  // 去掉注释与字符串，再去掉对象键（后面紧跟冒号的不是变量引用）
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/[A-Za-z_$][\w$]*\s*:/g, '');

  const bad = new Set();
  for (const m of clean.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*[A-Z][\w$]*)(?![.\w$])/g)) {
    const n = m[1];
    if (!defined.has(n)) bad.add(n);
  }
  ok(f + ' 无未定义变量', bad.size === 0, [...bad].join(', '));
}

console.log('\n通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
