/* Cloud Drive · 登录页逻辑
 *
 * 站点现在是「无门模式」，登录不需要先过保护密码 —— 所以这里没有门禁这一步，
 * 填昵称和密码直接登。账号本身就是那道门。
 */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var A = window.CloudAuth;

  function log(msg, kind) {
    var box = $('#log');
    var line = document.createElement('div');
    line.className = 'log-line' + (kind ? ' ' + kind : '');
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function back() {
    var to = 'index.html';
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('back') === '1') to = 'index.html';
    } catch (e) {}
    location.href = to;
  }

  /* ---------- 主题 ---------- */
  function initTheme() {
    var btn = $('#theme');
    function paint() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.textContent = dark ? '☀️ 浅色' : '🌗 深色';
    }
    paint();
    btn.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      var next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('cloud_drive_theme', next); } catch (e) {}
      paint();
    });
  }

  /* ---------- 入口 ---------- */
  function boot() {
    initTheme();

    // 已经有会话（可能是在 Chat / Code 登的）→ 先给个"直接用"的出口
    var id = A.uid();
    if (id) {
      $('#hasSession').style.display = '';
      $('#curNick').textContent = '已登录 · ' + id.slice(0, 8) + '…';
      $('#curSrc').textContent = '身份来自本机保存的会话（Cloud / Code / Chat 共用）';
      $('#loginBox').style.display = 'none';
    }

    $('#useIt').addEventListener('click', function () { back(); });
    $('#switchAcct').addEventListener('click', function () {
      $('#hasSession').style.display = 'none';
      $('#loginBox').style.display = '';
      log('可以登录另一个账号。登录后会覆盖本机的会话。');
    });

    $('#loginGo').addEventListener('click', doLogin);
    $('#pwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

    $('#toReg').addEventListener('click', function () {
      $('#loginBox').style.display = 'none';
      $('#regBox').style.display = '';
    });
    $('#backLogin').addEventListener('click', function () {
      $('#regBox').style.display = 'none';
      $('#loginBox').style.display = '';
    });

    $('#regGo').addEventListener('click', doReg);
    $('#redeemGo').addEventListener('click', doRedeem);

    log('填昵称和密码登录。没有账号就注册一个。');
  }

  function doLogin() {
    var n = $('#nick').value.trim(), p = $('#pwd').value;
    if (!n || !p) { log('昵称和密码都要填', 'err'); return; }
    $('#loginGo').disabled = true;
    A.login(n, p).then(function () {
      log('登录成功', 'ok');
      setTimeout(back, 300);
    }).catch(function (e) {
      // 站点现在是「无门模式」，正常不该再冒出这句。
      // 真冒出来了说明站点重新开了保护密码 —— 说清楚该去哪，别让用户干瞪眼。
      if (/保护密码/.test(e.message)) {
        log('这个站点开了保护密码，本页不提供输入它的入口。' +
            '请先到 Chat 登录（那边有门禁），再回到本页 —— 登录态是共享的。', 'err');
      } else {
        log('登录失败：' + e.message, 'err');
      }
    }).then(function () { $('#loginGo').disabled = false; });
  }

  function doReg() {
    var n = $('#rNick').value.trim(), p = $('#rPwd').value, p2 = $('#rPwd2').value;
    if (!n) { log('先起个昵称', 'err'); return; }
    if (p.length < 6) { log('密码至少 6 位', 'err'); return; }
    if (p !== p2) { log('两次输入的密码不一致', 'err'); return; }
    $('#regGo').disabled = true;
    A.register(n, p).then(function () {
      log('注册成功。新账号需要管理员审核通过后才能使用。', 'ok');
      $('#regBox').style.display = 'none';
      $('#loginBox').style.display = '';
      $('#nick').value = n;
    }).catch(function (e) {
      if (/保护密码/.test(e.message)) {
        log('这个站点开了保护密码，本页不提供输入它的入口。' +
            '请先到 Chat 登录（那边有门禁），再回到本页。', 'err');
      } else {
        log('注册失败：' + e.message, 'err');
      }
    }).then(function () { $('#regGo').disabled = false; });
  }

  function doRedeem() {
    var c = $('#ticket').value.trim();
    if (!c) { log('先粘贴票据码', 'err'); return; }
    $('#redeemGo').disabled = true;
    A.redeem(c).then(function () {
      log('兑换成功', 'ok');
      setTimeout(back, 300);
    }).catch(function (e) {
      log('兑换失败：' + e.message, 'err');
    }).then(function () { $('#redeemGo').disabled = false; });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
