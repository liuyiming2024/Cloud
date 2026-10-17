#!/usr/bin/env node
/* 校验 Cloud.api 的契约没被改坏。
 *
 * Code 的 js/drive.js 是照着一份**写死在它那边**的方法清单来调 Cloud.api 的。
 * 这里改了方法名、那边没跟着改，调用时就报"加密网盘没有 xxx 这个方法" ——
 * 而且只在 Code 里嵌 iframe 时才暴露，很难发现。
 *
 * 所以把 Code 依赖的那份清单抄在这里，每次改接口跑一遍。
 * 用法：node scripts/check-bridge.js <Cloud 目录>
 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2]||'.';
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};

console.log('Cloud.api 契约自检');

// Code 的 drive.js 实际会调的方法（从那边代码里抄来的）
const NEEDED=['ready','reason','who','list','remove','limits','upload','download','unlock'];

const src=fs.readFileSync(path.join(ROOT,'js/pageapi.js'),'utf8');
const body=src.slice(src.indexOf('const api = {'));
const have=new Set();
for(const m of body.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*[:]/gm)) have.add(m[1]);
for(const m of body.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*[(]/gm)) have.add(m[1]);
for(const m of body.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*[:=]\s*(async\s*)?function/gm)) have.add(m[1]);

for(const n of NEEDED) ok('Cloud.api.'+n+' 存在（Code 会调）', have.has(n));

// 契约版本必须存在，且是数字
const v=/version:\s*(\d+)/.exec(src);
ok('声明了契约版本', !!v);
if(v) ok('版本号是数字（Code 靠它判断兼容性）', Number.isInteger(+v[1]));

// 通道探测：Code 那边无法知道走的是快通道还是慢通道，
// 得有个方法让它问，否则界面上没法给出合理的等待提示
ok('提供 channel()（让 Code 知道要不要显示等待）', have.has('channel'));

/* 反向验证：只检查"方法在不在"，不等于"改坏了会报红"。
 * 所以这里造一份删掉方法的副本，跑自己，断言必须失败。
 * 用法：node scripts/check-bridge.js <Cloud目录> --self-test */
if (process.argv.includes('--self-test')) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  fs.mkdirSync(path.join(tmp, 'js'));
  const src2 = fs.readFileSync(path.join(ROOT, 'js/pageapi.js'), 'utf8');
  // 删掉 Code 会调的 download
  const broken = src2.replace(/\n\s*download:\s*async function[^\n]*\n/, '\n');
  if (broken === src2) {
    console.log('  ❌ 没能构造出损坏样例，反向验证本身无效');
    process.exit(1);
  }
  fs.writeFileSync(path.join(tmp, 'js/pageapi.js'), broken);
  const { execFileSync } = require('child_process');
  let code = 0;
  try {
    execFileSync(process.execPath, [__filename, tmp], { stdio: 'pipe' });
  } catch (e) { code = e.status; }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (code !== 0) {
    console.log('  ✅ 反向验证：改坏后确实报红（退出码 ' + code + '）');
    process.exit(0);
  }
  console.log('  ❌ 反向验证：改坏了却没报红，这个自检是摆设');
  process.exit(1);
}

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
