/* Worker 纯函数回归：base64 / blob sha1 / oid 校验 / meta 解码
 * 网络部分要真部署才测得动，这里先把不依赖网络的逻辑钉死。 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};

// 把 Worker 里的纯函数抠出来（不执行 export default，避免碰 fetch/env）
const src=fs.readFileSync(path.join(ROOT,'worker/drive.js'),'utf8');
const fnSrc=src.slice(src.indexOf('function base64('));
new Function(fnSrc+'\nthis.base64=base64;this.gitBlobSha=gitBlobSha;').call(globalThis);
globalThis.crypto=require('crypto').webcrypto;

(async()=>{
console.log('Worker 纯函数');

// base64 往返
const raw=new Uint8Array(300000); for(let i=0;i<raw.length;i++)raw[i]=(i*7+3)&255;
const b64=base64(raw.buffer);
const back=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
ok('base64 往返一致（300KB）', back.length===raw.length && back.every((v,i)=>v===raw[i]));
ok('base64 无换行', !/\n/.test(b64));

// blob sha1 要和 git 的算法一致：sha1("blob <len>\0" + content)
const {createHash}=require('crypto');
const expect=createHash('sha1')
  .update(Buffer.concat([Buffer.from('blob '+raw.length+'\0'),Buffer.from(raw)])).digest('hex');
ok('git blob sha1 与 Node 算法一致（差值判断靠它）', await gitBlobSha(raw.buffer)===expect);

// 空内容
ok('空内容 sha1 可用', (await gitBlobSha(new ArrayBuffer(0))).length===40);
ok('空内容 base64 可用', base64(new ArrayBuffer(0))==='');

// oid 白名单（会被拼进文件路径，必须挡住穿越）
const OID_RE=/^[A-Za-z0-9_-]{1,64}$/;
const evil=['../../etc/passwd','..','a/b','','x'.repeat(65),'uid with space','uid/../x','%2e%2e'];
const leaked=evil.filter(s=>OID_RE.test(s));
ok('恶意 oid 全被挡', leaked.length===0, '漏了: '+leaked.join(','));
ok('合法 oid 通过', OID_RE.test('anon-'+'a'.repeat(32)) && OID_RE.test('uid-real-999'));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
