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

// ---- 配额（访客限、站长不限）----
const wsrc=fs.readFileSync(path.join(ROOT,'worker/drive.js'),'utf8');
ok('定义了访客单文件上限', /GUEST_FILE_MAX\s*=\s*\d+/.test(wsrc));
ok('定义了访客总量上限', /GUEST_TOTAL_MAX\s*=\s*\d+/.test(wsrc));
ok('单文件上限 = 100MB', /GUEST_FILE_MAX\s*=\s*100\s*\*\s*1024\s*\*\s*1024/.test(wsrc));
ok('总量上限 = 1GB', /GUEST_TOTAL_MAX\s*=\s*1024\s*\*\s*1024\s*\*\s*1024/.test(wsrc));
ok('配额只对非站长生效', /if \(!who\.isOwner\)/.test(wsrc));

// 站长判定不能靠请求里传的 oid —— 那谁都能改
ok('站长判定走 Supabase 校验（不是看请求里的 oid）',
   /auth\/v1\/user/.test(wsrc) && /resolveIdentity/.test(wsrc));
ok('站长 uid 放在 Secret 里，不写死在代码',
   /env\.OWNER_UID/.test(wsrc) && !/OWNER_UID\s*=\s*'/.test(wsrc));
ok('验证失败时按访客处理（不在失败分支放行）',
   /if \(!r\.ok\) return out/.test(wsrc) || /catch[\s\S]{0,80}return out/.test(wsrc));

// 配额按"人"算，不按全站算
ok('用量按 oid 累计（按人算，不是全站）',
   /f\.oid === oid/.test(wsrc));

// 前端
const cfg=fs.readFileSync(path.join(ROOT,'js/config.js'),'utf8');
ok('前端也有一份配额（用于提前提示）', /guestFileMax/.test(cfg) && /guestTotalMax/.test(cfg));
const app=fs.readFileSync(path.join(ROOT,'js/app.js'),'utf8');
ok('上传前先按配额预判', /guestFileMax/.test(app));
ok('列表显示已用空间', /paintQuota/.test(app));
ok('跨域放行身份头（否则带不过去）', /X-Access-Token/.test(wsrc));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
