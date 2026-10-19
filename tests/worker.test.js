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
// ---- R4-03：身份必须走自建会话，不是 Supabase Auth ----
// 只看代码，不看注释（注释里会提到旧做法作为反面教材）
const wcode=wsrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
ok('代码里不再调 GoTrue /auth/v1/user（那是身份体系错配）',
   !/auth\/v1\/user/.test(wcode));
ok('改为调自建 RPC auth_uid', /rpc\/auth_uid|rpc\/' \+ fn/.test(wsrc) && /auth_uid/.test(wsrc));
ok('会话走 x-session 头（自建会话的约定）', /x-session/.test(wcode));
ok('站长靠服务端给的 role 判定（不是配一个 uid）',
   /auth_role/.test(wsrc) && /role === 'owner'/.test(wsrc) && !/OWNER_UID/.test(wsrc));
ok('不对"令牌无效"做惩罚（过期与伪造无法区分，罚了是自伤）',
   !/badToken[\s\S]{0,60}deny/.test(wsrc));

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

// ---- 惩罚性延迟 ----
ok('定义了累进延迟参数', /const TARPIT\s*=/.test(wsrc));
ok('有封顶（不能无限等）', /max:\s*\d+/.test(wsrc));
ok('有封禁阈值（不再陪他耗）', /banAfter:\s*\d+/.test(wsrc));
ok('延迟会翻倍（越试越久）', /Math\.pow\(2, s\.n\)/.test(wsrc));
ok('封顶值 = 30 秒（运行时宽限期上限）', /max:\s*30000/.test(wsrc));

// 三种伪造信号都走惩罚路径
ok('可疑 oid 一律走惩罚路径', /!OID_RE\.test\(oid\)[\s\S]{0,40}deny/.test(wsrc));
ok('非法 oid → 惩罚', /!OID_RE\.test\(oid\)[\s\S]{0,40}deny/.test(wsrc));
ok('访问别人的空间 → 惩罚', /oid !== who\.uid[\s\S]{0,60}deny/.test(wsrc));

// 该罚的罚，不该罚的别罚
ok('没配身份服务时不算伪造（不误伤访客）', /configured/.test(wsrc) && /if \(!env\.SB_URL/.test(wsrc));
ok('没带令牌不算伪造（老实匿名）', /if \(!tok\) return out/.test(wsrc));
ok('站长访问别人空间不罚（他本来就该能看）', /if \(!who\.isOwner\) \{[\s\S]*?isAnonSpace/.test(wsrc));
ok('超配额不惩罚（是正常使用，只说清差多少）',
   /单个文件最大/.test(wsrc) && !/deny\(ip[^\)]*单个文件/.test(wsrc));

// ---- R4-02：归属校验必须覆盖访客 ----
ok('归属校验不再有 who.uid && 前置（否则访客被跳过）',
   !/if \(who\.uid && !who\.isOwner/.test(wsrc));
ok('没身份时只允许匿名空间',
   /else if \(!isAnonSpace\)[\s\S]{0,40}deny/.test(wsrc));
ok('已登录只能访问自己 uid 或匿名空间',
   /oid !== who\.uid && !isAnonSpace/.test(wsrc));
ok('站长可访问所有人的空间', /if \(!who\.isOwner\)/.test(wsrc));
ok('get 查索引确认归属（不能只拼路径）', /hitG\.oid !== oid/.test(wsrc));
ok('del 查索引确认归属', /hit\.oid !== oid/.test(wsrc));
ok('list 按 oid 过滤（不返回别人的）', /f\.oid === oid/.test(wsrc));

// 消息要含糊，不能教他怎么改
const denies=[...wsrc.matchAll(/deny\(ip, '([^']*)'\)/g)].map(m=>m[1]);
ok('惩罚消息一律含糊（不透露是哪个环节错）',
   denies.length>0 && denies.every(m=>/^没有(权限|这个文件)$/.test(m)), denies.join('|'));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
})().catch(e=>{console.error('崩了',e);process.exit(1)});
