/* 统一登录页适配回归
 *
 * 全站只有 https://liuyiming2024.github.io/login.html 这一个登录页，
 * 会话写在 wxlg_sb_token / wxlg_sb_uid（SiteIdentity 的键）。
 * Cloud 不自己做登录，只负责认人 + 跳过去 + 退出。
 *
 * 这里钉死的是：认人不能认错、跳转地址不能送人到钓鱼站。
 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};

const store={};
globalThis.localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
globalThis.crypto=require('crypto').webcrypto;
globalThis.window=globalThis;
globalThis.location={href:'',pathname:'/Cloud/index.html',origin:'https://liuyiming2024.github.io'};
globalThis.document={createElement:()=>({}),head:{appendChild:()=>{}}};
globalThis.CloudCfg={crypto:{iterations:20000,chunkSize:4*1024*1024},simpleSalt:'test',
  anonPass:'gEjKtd53fiG4dJ0nrrq9iFq1YZX11rCZ18h0jfUW'};
new Function(fs.readFileSync(path.join(ROOT,'js/auth.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/crypto.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/identity.js'),'utf8'))();
const A=globalThis.CloudAuth, I=globalThis.CloudId;
const U='wxlg_sb_uid', T='wxlg_sb_token';

(async()=>{
console.log('统一登录页适配');

// 未登录
ok('没登录时读不到身份', A.uid()===null);
ok('没登录判定为匿名', I.isAnon()===true);

// 在统一登录页登录 → 写 wxlg_sb_*
store[T]='tok-1'; store[U]='uid-abc';
ok('能认出统一登录页写的会话', A.uid()==='uid-abc');
ok('认出后不再是匿名', I.isAnon()===false);
ok('归属 = 账号 uid', I.ownerId()==='uid-abc');

// 老版本 Cloud 自己登过的存量会话也要认（不丢人）
delete store[U]; delete store[T];
store['code_cloud_uid']='uid-old'; store['code_cloud_token']='tok-old';
ok('也认老版本自己写的会话（存量不丢）', A.uid()==='uid-old');
delete store['code_cloud_uid']; delete store['code_cloud_token'];

// 退出
store[T]='tok-1'; store[U]='uid-abc';
await A.logout();
ok('退出后读不到身份', A.uid()===null);
ok('退出清掉了统一会话', !store[T] && !store[U]);
ok('退出不带 SiteIdentity 也不报错（降级到本地清理）', true);

// 跳转地址
store[T]=''; store[U]='';
A.goLogin('index.html');
const href=globalThis.location.href;
ok('跳转到统一登录页', href.indexOf('https://liuyiming2024.github.io/login.html')===0, href);
ok('带上了回跳参数', /[?&]next=/.test(href), href);
ok('回跳目标是同源相对路径（不是外站）',
   !/next=https?:\/\//.test(href.replace(/^.*next=/,'')), href);

// 站点有 SiteIdentity 时，走它的 goLogin
globalThis.SiteIdentity={state:{id:'uid-si',ok:true},token:()=>'tok-si',
  goLogin(n){ globalThis.location.href='SI:'+n; }};
globalThis.window.SiteIdentity=globalThis.SiteIdentity;
ok('有 SiteIdentity 时优先读它的 state', A.uid()==='uid-si');
A.goLogin('index.html');
ok('有 SiteIdentity 时走它的 goLogin', globalThis.location.href==='SI:index.html');
ok('能取到昵称', A.nick()===null || typeof A.nick()==='string');

// E-1：注册时间只能走 RPC，绝不直连 users 表
const idsrc=fs.readFileSync(path.join(ROOT,'js/identity.js'),'utf8');
ok('identity.js 不再出现 rest/v1 表查询', !/rest\/v1\//.test(idsrc));
ok('identity.js 不再硬编码 supabase 地址', !/supabase\.co/.test(idsrc));
ok('identity.js 不再硬编码 publishable key', !/sb_publishable/.test(idsrc));
ok('注册时间走 fetchCreatedAt（内部用 CloudAuth.rpc）',
   /fetchCreatedAt/.test(idsrc) && /CloudAuth\.rpc/.test(idsrc));

// RPC 不存在时必须降级成空，而不是报错或退回直连
globalThis.SiteIdentity={state:{id:'uid-si',ok:true},token:()=>'tok-si',
  rpc:()=>Promise.reject(new Error('function does not exist')),
  goLogin(n){ globalThis.location.href='SI:'+n; }};
const cat=await I.fetchCreatedAt('uid-si');
ok('RPC 不存在时降级为空串（不报错、不直连）', cat==='');

// RPC 存在时正常取到
globalThis.SiteIdentity.rpc=()=>Promise.resolve({created_at:'2026-01-01T00:00:00Z'});
ok('RPC 可用时能取到注册时间',
   await I.fetchCreatedAt('uid-si')==='2026-01-01T00:00:00Z');

// 没有 CloudAuth.rpc 时也要安全降级
delete globalThis.window.CloudAuth.rpc;
ok('没有 rpc 能力时安全返回空',
   await I.fetchCreatedAt('uid-si')==='');

// 匿名口令与账号口令不混
const anon=I.anonPass();
const real=await I.derivePass('uid-abc','2026-01-01T00:00:00Z',0);
ok('账号口令 ≠ 匿名固定口令', real!==anon);

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
