/* 配额：两条通道必须一致
 * 配额只做在一条通道上等于没限 —— 绕过另一条就形同虚设。
 */
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2];
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  ✅ '+n)):(fail++,console.log('  ❌ '+n+(e?' —— '+e:'')))};

console.log('配额（两条通道）');

const w=fs.readFileSync(path.join(ROOT,'worker/drive.js'),'utf8');
const sh=fs.readFileSync(path.join(ROOT,'.github/drive.sh'),'utf8');

function num(expr){ return eval(expr.replace(/1024/g,'1024')); }
/* shell 写 GUEST_X_MAX=$((100 * 1024 * 1024))，JS 写 const GUEST_X_MAX = 100 * 1024 * 1024;
 * 两种写法各抓各的，别硬凑一条正则 —— 凑出来的要么漏要么错。 */
function grabShell(src, name) {
  const m = new RegExp(name + '=\\$\\(\\(([^)]+)\\)\\)').exec(src);
  return m ? m[1].trim() : null;
}
function grabJs(src, name) {
  const m = new RegExp(name + '\\s*=\\s*([0-9][0-9\\s*]+?)\\s*;').exec(src);
  return m ? m[1].trim() : null;
}
const wFile=grabJs(w,'GUEST_FILE_MAX'), wTot=grabJs(w,'GUEST_TOTAL_MAX');
const sFile=grabShell(sh,'GUEST_FILE_MAX'), sTot=grabShell(sh,'GUEST_TOTAL_MAX');

ok('两条通道都定义了单文件上限', !!wFile && !!sFile, 'w='+wFile+' s='+sFile);
ok('两条通道都定义了总量上限', !!wTot && !!sTot, 'w='+wTot+' s='+sTot);
if(wFile&&sFile) ok('单文件上限一致（' + eval(wFile) + '）', eval(wFile)===eval(sFile),
   'worker='+eval(wFile)+' sh='+eval(sFile));
if(wTot&&sTot) ok('总量上限一致（' + eval(wTot) + '）', eval(wTot)===eval(sTot),
   'worker='+eval(wTot)+' sh='+eval(sTot));

// 站长判定都不可伪造
ok('Worker 用 Supabase 验令牌（伪造不了）', /auth\/v1\/user/.test(w));
ok('Actions 用 github.actor（伪造不了）', /ACTOR/.test(sh) && /IS_OWNER/.test(sh));
ok('两条都不看请求里传的标记',
   !/oid\s*===\s*['"]liuyiming/.test(w) && !/OID\s*=\s*['"]liuyiming/.test(sh));

// 都按 oid 累计
ok('Worker 按 oid 累计用量', /f\.oid === oid/.test(w));
ok('Actions 按 oid 累计用量', /select\(\.oid==\$o\)/.test(sh));

// 超限要说明差多少（否则用户只能瞎猜该删多少）
ok('Worker 报错带具体数字', /还差/.test(w));
ok('Actions 报错带具体数字', /还差/.test(sh));

// 超配额不该被当成伪造惩罚
ok('超配额不进惩罚路径（是正常使用）',
   !/deny\(ip[^\n]*单个文件/.test(w) && /413/.test(w));

// 前端那份只用于提示，数值应与后端一致
const cfg=fs.readFileSync(path.join(ROOT,'js/config.js'),'utf8');
const cFile=/guestFileMax:\s*([\d\s*]+),/.exec(cfg);
const cTot =/guestTotalMax:\s*([\d\s*]+),/.exec(cfg);
if(wFile&&cFile) ok('前端提示值与后端一致（单文件）', eval(wFile)===eval(cFile[1]),
   'w='+eval(wFile)+' cfg='+eval(cFile[1]));
if(wTot&&cTot) ok('前端提示值与后端一致（总量）', eval(wTot)===eval(cTot[1]),
   'w='+eval(wTot)+' cfg='+eval(cTot[1]));

// ---- 语法自检 ----
/* drive.sh 是 Actions 里跑的，语法坏了本地测试一条都不会失败 ——
 * 只会在有人真上传时炸。必须显式 check。 */
(function(){
  const cp=require('child_process');
  let code=0,msg='';
  try{ cp.execFileSync('bash',['-n',path.join(ROOT,'.github/drive.sh')],{stdio:'pipe'}); }
  catch(e){ code=e.status; msg=String(e.stderr||'').slice(-120); }
  ok('drive.sh 语法可解析（坏了只有真上传时才炸）', code===0, msg);
})();

// ---- 归属校验：三条通道都要有 ----
ok('del 校验归属', /TARGET_OID[\s\S]{0,120}不属于你/.test(sh));
ok('get 也校验归属（不能只拼路径）', /GET_OID[\s\S]{0,120}不属于你/.test(sh));
const iChk=sh.indexOf('GET_OID='), iGet=sh.indexOf('DST="/tmp/drive/out.bin"');
ok('归属校验在读文件之前（不是读完才查）', iChk>0 && iChk<iGet, 'chk='+iChk+' get='+iGet);
ok('站长可越权处理（IS_OWNER 例外）', /IS_OWNER" != "true/.test(sh));
ok('list 按 oid 过滤', /select\(\.oid==\$o\)/.test(sh));

// Worker 三条接口也要有
ok('Worker get 校验归属', /hitG\.oid !== oid/.test(w));
ok('Worker del 校验归属', /hit\.oid !== oid/.test(w));
ok('Worker list 按 oid 过滤', /f\.oid === oid/.test(w));

console.log('\n通过 '+pass+'，失败 '+fail);
process.exit(fail?1:0);
