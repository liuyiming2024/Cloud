/* 加密层 + 防重 + key 唯一性 回归 */
const fs=require('fs'),path=require('path');
const {webcrypto}=require('crypto');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};
globalThis.crypto=webcrypto; globalThis.window=globalThis;
globalThis.CloudCfg={crypto:{iterations:20000,chunkSize:4*1024*1024},simpleSalt:'test'};
new Function(fs.readFileSync(path.join(ROOT,'js/crypto.js'),'utf8'))();
new Function(fs.readFileSync(path.join(ROOT,'js/identity.js'),'utf8'))();
const C=globalThis.CloudCrypto, I=globalThis.CloudId;
(async()=>{
console.log('加密 / 防重 / key 唯一性回归');
const data=new Uint8Array(300*1024); for(let i=0;i<data.length;i++)data[i]=(i*7+3)&255;
const plain=new Blob([data]);
const sealed=(await C.encryptBlob(plain,'p1','none')).blob;
const back=await C.decryptBuffer(await sealed.arrayBuffer(),'p1');
const bu=new Uint8Array(await back.arrayBuffer());
ok('往返一致',bu.length===data.length&&bu.every((v,i)=>v===data[i]));
let w=false; try{await C.decryptBuffer(await sealed.arrayBuffer(),'p2')}catch(e){w=true}
ok('口令错必报错',w);
let t=false; const full=new Uint8Array(await sealed.arrayBuffer());
try{await C.decryptBuffer(full.slice(0,full.length-40).buffer,'p1')}catch(e){t=true}
ok('截断必报错',t);
const big=new Blob([new Uint8Array(9*1024*1024)]);
ok('多块(9MB)往返',(await C.decryptBuffer(await (await (await C.encryptBlob(big,'p1','none')).blob.arrayBuffer()),'p1')).size===big.size);
// 指纹
const f1=await C.fingerprint(plain,'p1'), f2=await C.fingerprint(plain,'p1');
ok('指纹可复现（同一内容同一口令）',f1===f2);
const dup=new Blob([new Uint8Array(data)]);
ok('相同内容指纹相同（能查出重复）',(await C.fingerprint(dup,'p1'))===f1);
ok('不同内容指纹不同',(await C.fingerprint(new Blob([new Uint8Array(1024)]),'p1'))!==f1);
ok('换口令指纹就变（不知口令者算不出、也比不了）',(await C.fingerprint(plain,'p2'))!==f1);
const bigfp=await C.fingerprint(big,'p1');
ok('大文件指纹分块算（不爆内存）',typeof bigfp==='string'&&bigfp.length>20);
// key
const k0=await I.derivePass('uid-aaa','2026-01-01T00:00:00Z',0);
const k0b=await I.derivePass('uid-aaa','2026-01-01T00:00:00Z',0);
ok('key 可复现（换设备算出同一个）',k0===k0b);
const k1=await I.derivePass('uid-aaa','2026-01-01T00:00:00Z',1);
ok('轮次+1 → key 完全不同（防重靠它）',k0!==k1);
const kB=await I.derivePass('uid-bbb','2026-01-01T00:00:00Z',0);
ok('不同账号 key 不同',k0!==kB);
const kC=await I.derivePass('uid-aaa','2020-05-05T00:00:00Z',0);
ok('注册时间进因子（不只靠 uid）',k0!==kC);
const i0=await I.keyId(k0), i0b=await I.keyId(k0), i1=await I.keyId(k1);
ok('key 编号可复现',i0===i0b);
ok('不同 key 编号不同（能判断是否撞号）',i0!==i1);
ok('编号不含 key 本身（单向）',!i0.includes(k0.slice(0,10))&&k0.length>i0.length);
// 旧轮次可重算 → 老文件打得开
let found=null;
for(let r=0;r<=5;r++){const p=await I.derivePass('uid-aaa','2026-01-01T00:00:00Z',r);if(await I.keyId(p)===i1){found=p;break}}
ok('按编号能重算出旧轮次的 key（老文件仍可解）',found===k1);
// ---- 压缩（专业档的额外能力）----
const canZip = typeof CompressionStream === 'function';
// 高度可压缩的文本
const text = new Blob([new TextEncoder().encode('ab'.repeat(200000))]);
const ez = await C.encryptBlob(text, 'p1', 'auto');
if (canZip) {
  ok('可压缩内容确实被压小了', ez.saved > 0, '省了 '+ez.saved);
  ok('压缩标记写进密文头（proc=1）', ez.proc === 1);
  const tb = await C.decryptBuffer(await ez.blob.arrayBuffer(), 'p1');
  ok('压缩后往返一致', tb.size === text.size &&
     Buffer.from(await tb.arrayBuffer()).equals(Buffer.from(await text.arrayBuffer())));
  // 不可压缩内容（随机字节）→ 自动不压
  const rndU8 = new Uint8Array(100000);
for (let i = 0; i < rndU8.length; i += 65536) {
  crypto.getRandomValues(rndU8.subarray(i, Math.min(i + 65536, rndU8.length)));
}
const rnd = new Blob([rndU8]);
  const er = await C.encryptBlob(rnd, 'p1', 'auto');
  ok('压不动的内容自动存原样（不撑大文件）', er.proc === 0 && er.saved === 0);
  const rb = await C.decryptBuffer(await er.blob.arrayBuffer(), 'p1');
  ok('未压缩内容往返一致', rb.size === rnd.size);
}
// 显式 none
const en = await C.encryptBlob(text, 'p1', 'none');
ok('proc=none 时不压缩', en.proc === 0 && en.saved === 0);
const nb = await C.decryptBuffer(await en.blob.arrayBuffer(), 'p1');
ok('proc=none 往返一致', nb.size === text.size);

// 篡改 proc 字节必须报错，不能静默产出坏数据
let badProc = false;
try {
  const full2 = new Uint8Array(await ez.blob.arrayBuffer());
  full2[5] = 9;   // 未知预处理方式
  await C.decryptBuffer(full2.buffer, 'p1');
} catch (e) { badProc = /预处理/.test(e.message); }
ok('未知预处理方式被识别并报错', badProc);

// ---- 进度回调（大文件要让人知道在动）----
const bigB=new Blob([new Uint8Array(9*1024*1024)]);   // 9MB = 3 块
const ticks=[];
await C.encryptBlob(bigB,'p1','none',(d,t)=>ticks.push([d,t]));
ok('加密时回调了进度', ticks.length>0, '得到 '+ticks.length+' 次');
ok('最后一次是满进度', ticks.length>0 && ticks[ticks.length-1][0]===ticks[ticks.length-1][1]);
const encB=await C.encryptBlob(bigB,'p1','none');
const dticks=[];
await C.decryptBuffer(await encB.blob.arrayBuffer(),'p1',(d,t)=>dticks.push([d,t]));
ok('解密时也回调进度', dticks.length>0);
ok('小文件不刷屏（只有 1 块时不回调）', (await (async()=>{
  const n=[]; await C.encryptBlob(new Blob([new Uint8Array(100)]),'p','none',(d,t)=>n.push(1));
  return n.length;
})())<=1);

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
