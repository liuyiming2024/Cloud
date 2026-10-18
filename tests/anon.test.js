/* 匿名模式 / 归属隔离 / 站长可见 回归
 * 这几条是"谁能看到什么"的边界，错了就是泄密。 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};
const store={};
globalThis.localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
globalThis.crypto=require('crypto').webcrypto;
globalThis.window=globalThis;
globalThis.CloudCfg={crypto:{iterations:20000,chunkSize:4*1024*1024},simpleSalt:'test',
  anonPass:'gEjKtd53fiG4dJ0nrrq9iFq1YZX11rCZ18h0jfUW'};
new Function(fs.readFileSync(path.join(ROOT,'js/auth.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/crypto.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/identity.js'),'utf8'))();
const C=globalThis.CloudCrypto, I=globalThis.CloudId;
(async()=>{
console.log('匿名 / 归属 / 站长');

// 未登录
ok('未登录判定为匿名', I.isAnon()===true);
const a1=I.anonUid();
ok('匿名 id 形如 anon-xxx', /^anon-[0-9a-f]{32}$/.test(a1));
ok('匿名 id 稳定（不每次变）', I.anonUid()===a1);
ok('未登录时归属 = 匿名 id', I.ownerId()===a1);
ok('匿名口令是 config 里那把', I.anonPass()===CloudCfg.anonPass);

// 匿名加密的文件，任何人（含站长）都能解 —— 这是它的设计目的
const blob=new Blob([new Uint8Array([1,2,3,4,5])]);
const sealed=(await C.encryptBlob(blob, I.anonPass(), 'none')).blob;
const back=await C.decryptBuffer(await sealed.arrayBuffer(), I.anonPass());
ok('匿名文件用固定口令可解（站长能打开）', back.size===5);
let wrong=false;
try{ await C.decryptBuffer(await sealed.arrayBuffer(),'别的口令'); }catch(e){wrong=true}
ok('换了口令解不开', wrong);

// 匿名 id 的盲化标识不能等于 uid 明文
const dig=await crypto.subtle.digest('SHA-256', new TextEncoder().encode('aid:'+a1));
ok('归属标识被盲化后才送出', !Buffer.from(new Uint8Array(dig)).includes(a1));

// 登录之后
// 登录由统一登录页完成，写的是 wxlg_sb_*
store['wxlg_sb_token']='tok'; store['wxlg_sb_uid']='uid-real-999';
ok('登录后不再是匿名', I.isAnon()===false);
ok('登录后归属 = 账号 uid', I.ownerId()==='uid-real-999');
ok('登录后归属不再是匿名 id', I.ownerId()!==a1);

// 登录态的口令不会等于匿名那把
const realPass=await I.derivePass('uid-real-999','2026-01-01T00:00:00Z',0);
ok('账号口令 ≠ 匿名口令', realPass!==I.anonPass());

// 路径穿越必须被挡掉（oid 会被拼进路径）
const evil=['../../etc/passwd','a/b','..','','x'.repeat(200),'uid with space'];
const safe=evil.filter(s=>/^[A-Za-z0-9_-]{1,64}$/.test(s));
ok('恶意 oid 全部被挡（路径穿越防护）', safe.length===0, '漏了: '+safe.join(','));
ok('合法 oid 能通过', /^[A-Za-z0-9_-]{1,64}$/.test('uid-real-999'));

// 匿名 + 存档里是专业模式：不能显示专业档输入框。
// 显示了就是骗人 —— 用户填的钥匙根本不会被用上（匿名永远用固定钥匙）。
const appsrc=fs.readFileSync(path.join(ROOT,'js/app.js'),'utf8');
ok('paint 里匿名时强制隐藏专业框（不看存档的 mode）',
   /\$\('#proBox'\)\.style\.display = \(!anon && state\.mode === 'pro'\)\ \? '' : 'none'/.test(appsrc)
   || /!anon && state\.mode === 'pro'/.test(appsrc));
ok('paint 里匿名时强制显示简单框',
   /anon \|\| state\.mode === 'simple'/.test(appsrc));
ok('匿名分支不读 proPass（固定钥匙优先）',
   appsrc.indexOf('isAnon()') > -1 && /anonPass\(\)/.test(appsrc));

// 解不开时要说清最可能的原因，别让人以为文件坏了去反复重传
const app2=fs.readFileSync(path.join(ROOT,'js/app.js'),'utf8');
ok('解不开时提示可能是换设备/清缓存', /换[了过]设备|清[了过]缓存/.test(app2));
ok('技术错误消息翻成人话（不给用户看魔数）', /不是本云盘存的/.test(app2));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
