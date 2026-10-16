#!/usr/bin/env node
/* 校验 api/manifest.json 有没有说谎。
 *
 * 这类清单最容易出的毛病不是写错格式，是**声明了不存在的东西**：
 * 路径改了没同步、方法删了还留着。用的人照着清单调用才发现 404，
 * 那这份清单就成了误导。
 *
 * 所以这里做两件事：
 *   1. endpoints 里每个 path，在仓库里真的有这个文件；
 *   2. pageApi 里每个 Cloud.api.xxx，在 js/pageapi.js 里真的导出了。
 *
 * 用法：node scripts/check-api.js <Cloud 目录>
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || '.';
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e ? ' —— ' + e : '')); }
};

console.log('api/manifest.json 自检（' + ROOT + '）');

const mfPath = path.join(ROOT, 'api/manifest.json');
if (!fs.existsSync(mfPath)) {
  console.error('  ❌ 没有 api/manifest.json');
  process.exit(1);
}

let mf;
try {
  mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  ok('manifest 是合法 JSON', true);
} catch (e) {
  ok('manifest 是合法 JSON', false, e.message);
  process.exit(1);
}

// 必填字段
['name', 'version', 'desc', 'homepage', 'repo', 'endpoints', 'updated'].forEach((k) => {
  ok('有字段 ' + k, mf[k] !== undefined && mf[k] !== '');
});

// 1. endpoints 声明的路径真的存在
console.log('  —— endpoints ——');
for (const ep of mf.endpoints || []) {
  const p = String(ep.path || '');
  // /Cloud/api/manifest.json → api/manifest.json
  const rel = p.replace(/^\/Cloud\//, '');
  const local = path.join(ROOT, rel);
  ok(p + ' 存在', fs.existsSync(local), local);
}

// 2. pageApi 声明的方法真的导出了
console.log('  —— pageApi ——');
const src = fs.readFileSync(path.join(ROOT, 'js/pageapi.js'), 'utf8');
const declared = new Set();
for (const line of mf.pageApi || []) {
  const m = /Cloud\.api\.([A-Za-z0-9_]+)\s*\(/.exec(line);
  if (!m) { ok('能解析声明：' + line, false); continue; }
  declared.add(m[1]);
}
// 从源码里把 api 对象的键捞出来
const exported = new Set();
const body = src.slice(src.indexOf('const api = {'));
for (const m of body.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*:/gm)) exported.add(m[1]);

for (const name of declared) {
  ok('Cloud.api.' + name + ' 已实现', exported.has(name), '源码里没找到');
}

// 反过来：实现了但没写进清单的（不算错，但提醒一句，免得漏）
const undocumented = [...exported].filter((x) => !declared.has(x));
if (undocumented.length) {
  console.log('  ⚠  已实现但未写进清单：' + undocumented.join(', ') + '（补上更好）');
}

// 3. 清单里的 limits 要和 config.js 对得上
console.log('  —— 与 config.js 一致性 ——');
const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
const hint = /bigFileHint:\s*([0-9]+)\s*\*\s*1024\s*\*\s*1024/.exec(cfg);
if (hint && mf.limits) {
  ok('autoSwitchAt 与 config 一致',
     Number(hint[1]) * 1024 * 1024 === mf.limits.autoSwitchAt,
     '清单 ' + mf.limits.autoSwitchAt + ' vs config ' + Number(hint[1]) * 1024 * 1024);
}

console.log('\n通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
