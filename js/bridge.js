/* Cloud Drive · 与 Code 项目云盘的互通
 *
 * ---------- 两个盘，别混为一谈 ----------
 *   项目云盘（Code / code_files）  走 Supabase，秒级，存代码原文（明文），按路径组织
 *   加密网盘（本页 / Cloud）        走 GitHub，要等 Actions，内容在离开浏览器前就加密好了
 *
 * 账号是同一套（全站统一身份），但**存储完全独立**，不会自动互相同步。
 * 自动同步没有正确答案 —— 冲突该听谁的只能由人决定。
 *
 * ---------- 这个文件做什么 ----------
 * 1. 被 Code 以隐藏 iframe 加载时，收起界面，只当模块用；
 * 2. 反向：本页能读 Code 的项目云盘，把小文件转存进来（升级通道）。
 *
 * 反向那条只有在 Code 的 iframe 里才成立（要拿 Code.cloud 的能力）。
 * 单独打开本页时 importFromCode() 会如实报告不可用，而不是假装能行。
 */
(function () {
  var CLOUD_PAGE = 'https://liuyiming2024.github.io/Cloud/';

  /* 我是不是被别人当模块加载着？
     只看是不是嵌在 iframe 里、且栈顶是同源 —— 不同源的 iframe 读不到 parent，
     那时候什么都不做，老老实实当普通页面。 */
  function embedded() {
    try {
      return window.parent !== window && !!getTopCloud();
    } catch (e) { return false; }
  }
  function getTopCloud() {
    try { return window.parent.Code || null; } catch (e) { return null; }
  }

  /* 被嵌入时收起界面。
     不这么做的话，Code 里嵌着的这个 iframe 会把整页 UI 都渲染一遍 ——
     虽然藏起来了看不见，但日志、目录刷新全在跑，白白占资源。 */
  function slim() {
    var w = document.querySelector('.wrap');
    if (!w) return;
    w.style.display = 'none';
    document.title = 'Cloud Drive（模块模式）';
  }

  /* 从 Code 的项目云盘读一份文件 */
  function codeFileGet(path) {
    var C = getTopCloud();
    if (!C || !C.cloud || typeof C.cloud.fileGet !== 'function') {
      return Promise.reject(new Error('拿不到项目云盘（本页需要嵌在 Code 里才能用）'));
    }
    return C.cloud.fileGet(path);
  }

  function codeFileList() {
    var C = getTopCloud();
    if (!C || !C.cloud || typeof C.cloud.fileList !== 'function') {
      return Promise.reject(new Error('拿不到项目云盘（本页需要嵌在 Code 里才能用）'));
    }
    return C.cloud.fileList();
  }

  /* 把项目云盘里的一个文件转存进加密网盘。
   *
   * 路径即名字：那边是按路径组织的，直接拿路径当文件名，
   * 转过来之后还能看出它原来在哪。 */
  async function importFromCode(path) {
    // 顺序有讲究：先确认拿得到项目云盘 —— 那是这条通道成立的前提，
    // 缺了它这个功能根本不存在。放在后面查的话，两个都缺时会先报
    // "加密网盘没就绪"，把人引到错误的地方去排查。
    var c = await codeFileGet(path);
    var api = window.Cloud && window.Cloud.api;
    if (!api) throw new Error('加密网盘还没就绪');
    var text = (c && typeof c === 'object' && 'content' in c) ? c.content : String(c);
    var blob = new Blob([text], { type: 'text/plain; charset=utf-8' });
    return api.upload(blob, path);
  }

  window.CloudBridge = {
    embedded: embedded,
    codeFileList: codeFileList,
    codeFileGet: codeFileGet,
    importFromCode: importFromCode
  };

  /* 启动：被嵌入就收起界面 */
  function boot() {
    try {
      if (embedded()) slim();
    } catch (e) { /* 判断失败就当普通页面，不影响主流程 */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
