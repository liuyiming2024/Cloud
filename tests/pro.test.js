/* 专业档附加能力：分卷 / zip / crc32 / 清单 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};
globalThis.crypto=require('crypto').webcrypto;
globalThis.window=globalThis;
new Function(fs.readFileSync(path.join(ROOT,'js/pro.js'),'utf8'))();
const P=globalThis.CloudPro;
(async()=>{
console.log('专业档附加能力');

// crc32 对已知值
ok('crc32("") = 0', P.crc32(new Uint8Array(0))===0);
ok('crc32 已知向量（"123456789" = 0xCBF43926）',
   P.crc32(new TextEncoder().encode('123456789'))===0xCBF43926,
   P.crc32(new TextEncoder().encode('123456789')).toString(16));

// 分卷
const data=new Uint8Array(20*1024*1024+1234); for(let i=0;i<data.length;i++)data[i]=i&255;
const big=new Blob([data]);
const vols=P.split(big,8*1024*1024);
ok('分卷数正确（20MB+ / 8MB = 3 卷）', vols.length===3, '得到 '+vols.length);
ok('各卷大小之和 = 原大小', vols.reduce((a,v)=>a+v.size,0)===big.size);
ok('除末卷外都是整卷', vols[0].size===8*1024*1024 && vols[1].size===8*1024*1024);
const v1=P.split(big,1024*1024*1024);
ok('卷大于文件时不分卷', v1.length===1);
ok('空文件也能分（至少一卷）', P.split(new Blob([]),1024).length>=1);

// 拼回一致（模拟下载时按序 concat）
const parts=[];
for(const v of vols) parts.push(new Uint8Array(await v.arrayBuffer()));
const all=new Uint8Array(parts.reduce((a,x)=>a+x.length,0));
let p=0; for(const x of parts){all.set(x,p);p+=x.length;}
ok('分卷后拼回字节一致', all.length===data.length && all.every((v,i)=>v===data[i]));

// zip
const e1=new Blob([new TextEncoder().encode('hello world')]);
const e2=new Blob([new Uint8Array([0,1,2,3,4,5])]);
const zip=await P.zipStore([{name:'a.txt',blob:e1},{name:'bin.dat',blob:e2}]);
ok('生成了 zip', zip.size>0 && zip.type==='application/zip');
const zb=Buffer.from(await zip.arrayBuffer());
ok('EOCD 签名正确', zb.readUInt32LE(zb.length-22)===0x06054b50);
const n=zb.readUInt16LE(zb.length-12);   // EOCD 共 22 字节，总条目数在偏移 10
ok('EOCD 记录的文件数 = 2', n===2, '得到 '+n);
ok('含本地头签名', zb.includes(Buffer.from([0x50,0x4b,0x03,0x04])));
ok('含中央目录签名', zb.includes(Buffer.from([0x50,0x4b,0x01,0x02])));
// CRC 写进去了吗
const c1=P.crc32(new Uint8Array(await e1.arrayBuffer()));
const c1buf=Buffer.from([c1&255,(c1>>>8)&255,(c1>>>16)&255,(c1>>>24)&255]);
ok('CRC32 被写进本地头', zb.includes(c1buf));
// 中文文件名
const zc=await P.zipStore([{name:'中文 文件.txt',blob:e1}]);
ok('中文文件名不报错', zc.size>0);

// 清单
const mt=P.manifestText([{fp:'abc123',size:100,name:'a.txt'}]);
ok('清单含指纹', mt.includes('abc123'));
ok('清单含文件名', mt.includes('a.txt'));
ok('清单说明了指纹怎么来的', /HMAC/.test(mt));
ok('空清单也能生成', typeof P.manifestText([])==='string');

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
