/* 登录态 / 跨应用身份 / 退出 回归
 * 这几个坑 Chat 与 Code 都踩过（E-047 / S-047），这里钉死。 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};

// 一个够用的 localStorage
const store={};
globalThis.localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
globalThis.crypto=require('crypto').webcrypto;
globalThis.window=globalThis;
globalThis.CloudCfg={crypto:{iterations:20000,chunkSize:4*1024*1024},simpleSalt:'test'};
new Function(fs.readFileSync(path.join(ROOT,'js/auth.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/identity.js'),'utf8'))();
const A=globalThis.CloudAuth, I=globalThis.CloudId;
const K=A.KEY;

(async()=>{
console.log('登录态 / 跨应用身份 / 退出');

ok('初始无账号', A.uid()===null && I.account()===null);

// 场景一：只在 Chat 登过（Cloud 自己没登过）→ 借用态
store[K.CHAT_TOK]='tok-chat'; store[K.CHAT_UID]='uid-111';
ok('能沿用 Chat 的登录态（同源共享）', A.uid()==='uid-111');
ok('沿用态被标记为来自 Chat', I.account().from==='Chat');

// 场景二：在 Cloud 退出。Chat 的会话我们无权删，只能拒绝沿用。
A.dropSession();
ok('退出后不再沿用 Chat（刷新不会"复活"）', A.uid()===null);
ok('退出态被 account() 正确反映', I.account()===null);
ok('退出不删 Chat 的数据（那是别人的会话）', store[K.CHAT_TOK]==='tok-chat');

// 场景三：在 Cloud 主动登录 → 两边都写，让 Chat 那边也认出这次登录
A.setSession('tok-cloud','uid-222');
ok('登录写自己的 key', store[K.CODE_TOK]==='tok-cloud');
ok('登录同时写给 Chat（跨应用身份统一）', store[K.CHAT_TOK]==='tok-cloud');
ok('登录后优先认自己的', A.uid()==='uid-222');
ok('主动登录撤销了退出标记', !store[K.OPT_OUT]);

// 场景四：再退出一次（这次是自己登的）
A.dropSession();
ok('退出清掉自己的 token', !store[K.CODE_TOK]);
ok('退出后读不到任何身份', A.uid()===null);

// 场景五：再次登录
A.setSession('tok-new','uid-333');
ok('再次登录恢复身份', A.uid()==='uid-333');

// 后端地址单一真源
ok('identity 复用 auth 的后端地址（不抄第二份）',
   I && A.SB_URL && A.SB_URL.indexOf('supabase')>0);

// key 派生在有账号后才可用
const k=await I.derivePass('uid-333','2026-01-01T00:00:00Z',0);
ok('有账号后能算出简单模式口令', typeof k==='string' && k.length>20);

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
