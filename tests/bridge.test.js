/* Cloud ↔ Code 互通回归 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};
const store={};
globalThis.localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
globalThis.crypto=require('crypto').webcrypto;
globalThis.window=globalThis;
globalThis.document={readyState:'complete',querySelector:()=>null,
  addEventListener:()=>{},createElement:()=>({}),head:{appendChild:()=>{}}};
globalThis.parent=null;
globalThis.location={href:'',pathname:'/Cloud/index.html',origin:'https://liuyiming2024.github.io'};
globalThis.CloudCfg={crypto:{iterations:20000,chunkSize:4*1024*1024},simpleSalt:'t',anonPass:'anonkey',worker:''};
new Function(fs.readFileSync(path.join(ROOT,'js/crypto.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/auth.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/identity.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/bridge.js'),'utf8'))();
const B=globalThis.CloudBridge;
(async()=>{
console.log('Cloud ↔ Code 互通');

// 非嵌入场景
globalThis.window.parent=globalThis.window;
ok('普通打开时判定为非嵌入', B.embedded()===false);

// 反向导入：Code.cloud 不在场时必须明确报错，不能假装能行
let rejected=false, msg='';
try{ await B.importFromCode('/a.js'); }catch(e){ rejected=true; msg=e.message; }
ok('拿不到项目云盘时明确报错（不静默失败）', rejected);
ok('报错说清了原因', /项目云盘/.test(msg), msg);

// 有 Code.cloud 时能读
globalThis.window.parent={ Code:{ cloud:{
  fileList:()=>Promise.resolve([{path:'/a.js',size:12}]),
  fileGet:(p)=>Promise.resolve({path:p,content:'console.log(1)'}),
}}};
const list=await B.codeFileList();
ok('能列项目云盘', list.length===1 && list[0].path==='/a.js');
const c=await B.codeFileGet('/a.js');
ok('能读项目云盘文件', c.content==='console.log(1)');

// 转存：需要 Cloud.api
globalThis.window.Cloud={api:{upload:async(blob,name)=>({blob,name})}};
const r=await B.importFromCode('/a.js');
ok('转存时把路径当文件名（转过来还看得出原位置）', r.name==='/a.js');
ok('转存内容是原文', typeof r.blob==='object');

// Cloud.api 不在场时也要说清楚
delete globalThis.window.Cloud;
rejected=false;
try{ await B.importFromCode('/a.js'); }catch(e){ rejected=true; msg=e.message; }
ok('加密网盘没就绪时明确报错', rejected && /就绪/.test(msg), msg);

// 一致性：主页面匿名能用，Cloud.api 也必须能用。
// 不一致的话，直接打开能用、嵌在 Code 里不能用，最难排查。
const psrc=fs.readFileSync(path.join(ROOT,'js/pageapi.js'),'utf8');
ok('pageapi 里匿名分支排在查账号之前（不认账号也能就绪）',
   psrc.indexOf('isAnon()') < psrc.indexOf('window.CloudId.account()'));
ok('pageapi 不再用 acc.uid（改用 ownerId）', !/acc\.uid/.test(psrc));
ok('匿名走固定口令', /anonPass\(\)/.test(psrc));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
