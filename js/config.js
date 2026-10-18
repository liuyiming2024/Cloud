/* Cloud Drive · 配置
 * 公开仓库（Cloud）里只出现它自己的仓库名。
 * 私有存储库的名字与地址不写在这里，也不写进任何前端文件——
 * 它由 Actions 侧的 Secrets 持有，页面永远拿不到。
 */
window.CloudCfg = {
  // 页面所在的公开仓库（Pages 站点本身）
  owner: 'liuyiming2024',
  repo: 'Cloud',

  // 搬运工作流。页面只会触发它，不会也不该知道它把文件搬到哪
  workflow: 'drive.yml',

  // 暂存区路径（都在公开仓库内，内容一律是密文）
  inbox: 'inbox',    // 上传：页面写 → Actions 取走
  outbox: 'outbox',  // 下载：Actions 放 → 页面取走
  status: 'status',  // 任务回执

  // 上传专用 token 存在浏览器本地，key 名
  tokenKey: 'cloud_drive_token',

  // 后端地址。填了就走它 —— 游客什么都不用填，令牌在后端手里。
  // 留空则退回直连 GitHub（那样必须自己填令牌）。
  worker: '',

  /* 访客配额。
   *
   * 站长不限 —— 那是他自己的仓库。
   * 访客要限：仓库是公摊的，不限的话一个人就能把它撑到没法维护。
   *
   * 配额按"人"算，不按全站算：
   *   按全站算会出现"来得早的能用、来得晚的用不了"，而且先到的人
   *   占满了之后，后来者连一个文件都传不了。
   *
   * 这些数字只在前端做提示，真正的拦截在后端（Worker）。
   * 前端提示是为了让人立刻知道，不用等传完才失败 ——
   * 但前端拦不住人，绕过它改个数字就行，所以后端必须再拦一次。 */
  quota: {
    guestFileMax: 100 * 1024 * 1024,     // 访客单文件 100MB
    guestTotalMax: 1024 * 1024 * 1024,   // 访客总共 1GB
    ownerLogin: 'liuyiming2024'          // 站长账号（用 uid 比对，见 app.js）
  },

  crypto: {
    // 标准档：PBKDF2 25 万次。改了会导致旧文件解不开
    iterations: 250000,
    // 专业档：PBKDF2 100 万次，慢 4 倍，代价是每次开文件要多等一两秒
    proIterations: 1000000,
    chunkSize: 4 * 1024 * 1024 // 分块 4MB，避免大文件一次性进内存
  },

  /* 匿名模式的固定口令。
   *
   * 为什么是公开的：匿名上传的东西本来就是"交给站长的"，
   * 站长必须能打开，否则这个功能没有意义。代价是——
   * 任何看到本文件的人同样能打开。所以界面上把这话说死：
   * 匿名上传 ≠ 保密，要保密就登录、用专业模式。
   *
   * 改这个值等于把此前所有匿名文件一次性作废，
   * 除非你把旧值也留着（见 identity.js 的 anonPass）。
   */
  anonPass: 'gEjKtd53fiG4dJ0nrrq9iFq1YZX11rCZ18h0jfUW',

  // 超过这个字节走 Release 通道（由 Actions 侧决定，这里只用于提示）
  bigFileHint: 50 * 1024 * 1024
};
