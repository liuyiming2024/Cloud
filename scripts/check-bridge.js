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

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
