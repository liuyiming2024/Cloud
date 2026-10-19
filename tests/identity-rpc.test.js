/* Worker 调的身份函数必须在 Chat 的白名单里。
 *
 * 这是本轮真出事的地方：V-03 把 blanket grant 收窄成逐函数白名单后，
 * auth_uid()/auth_role() 被显式 revoke，而 Worker 还在调它们 ——
 * 结果所有登录用户被降级成访客：既受配额，又因"无身份只能进 anon- 空间"
 * 连自己的 uid 空间都进不去，功能完全不可用。
 *
 * 这条测试直接读 Chat 的 schema.sql 做交叉验证，
 * 以后再收窄授权，这里会立刻报红。
 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
const SCHEMA=process.argv[3];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};

console.log('Worker × Chat 授权契约');

const w=fs.readFileSync(path.join(ROOT,'worker/drive.js'),'utf8');
// 只看代码，剥掉注释
const wc=w.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');

// Worker 实际调用的 RPC
const calls=[...wc.matchAll(/\/rest\/v1\/rpc\/([a-z_0-9]+)/g)].map(m=>m[1]);
ok('Worker 调了 RPC 做身份解析', calls.length>0, calls.join(','));

if(!fs.existsSync(SCHEMA)){
  console.log('  ⚠ 未给 schema 路径，跳过授权交叉验证');
  console.log('\n通过 '+pass+'，失败 '+fail);
  process.exit(fail?1:0);
}
const sql=fs.readFileSync(SCHEMA,'utf8');

// 白名单：显式 grant ... to anon 的函数
const whitelist=new Set();
for(const m of sql.matchAll(/grant\s+execute\s+on\s+function\s+([a-z_0-9]+)\s*\([^)]*\)\s+to\s+([^;]*);/g)){
  if(/anon/.test(m[2])) whitelist.add(m[1]);
}
// 黑名单：显式 revoke ... from public
const revoked=new Set();
for(const m of sql.matchAll(/revoke\s+execute\s+on\s+function\s+([a-z_0-9]+)\s*\([^)]*\)\s+from\s+public/g)){
  revoked.add(m[1]);
}
for(const m of sql.matchAll(/'revoke execute on function ([a-z_0-9]+)\([^)]*\) from public'/g)){
  revoked.add(m[1]);
}

ok('schema 里已收窄（无 blanket grant）', !/grant execute on all functions in schema public to anon/.test(sql));

/* schema 用的是 revoke-from-public → grant-to-anon 两段式：
 * 先关掉 Postgres 默认给 PUBLIC 的执行权，再按白名单放开。
 * 所以"出现在 revoke 列表里"是正常的，关键是**之后有没有被 grant 回来**。
 * 只看 revoke 会误判，只看 grant 会漏判 —— 两个都得看。 */
for(const fn of calls){
  ok(`Worker 调的 ${fn}() 在白名单里`, whitelist.has(fn),
     whitelist.has(fn)?'':`★ 不在白名单 → 会 403 → 登录用户被降级成访客`);
  if(revoked.has(fn)) ok(`${fn}() 先 revoke 再 grant（顺序正确）`, whitelist.has(fn));
}

// whoami 必须带我们要的字段
const wm=/create or replace function whoami\(\)[\s\S]*?\$\$;/.exec(sql);
if(calls.includes('whoami') && wm){
  ok('whoami 返回 id（判定归属用）', /'id',\s*u\.id/.test(wm[0]));
  ok('whoami 返回 role（判定站长用）', /'role',\s*u\.role/.test(wm[0]));
  ok('whoami 用 ok 标志区分未登录', /'ok',\s*false/.test(wm[0]));
}

// 反向：确认 auth_uid/auth_role 确实是被 revoke 的（若哪天又放开，这条会提醒）
ok('auth_uid 确实已被 revoke（所以不能用它）', revoked.has('auth_uid'));
ok('auth_role 确实已被 revoke（所以不能用它）', revoked.has('auth_role'));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
