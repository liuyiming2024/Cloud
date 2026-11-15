# Cloud Drive

浏览器里的加密网盘。文件在你按下上传之前就已经是密文，
之后它只是在两个仓库之间被搬了一趟——搬它的那一方，你这边也看不到。

**在线地址**：<https://liuyiming2024.github.io/Cloud/>

## 怎么用

1. 打开上面的地址，填一枚 GitHub Personal Access Token（需要这个仓库的
   `contents: write` 与 `actions: write`）
2. 填一个加密口令
3. 选文件，点「加密并存储」
4. 下载时填**同一个**口令

## 三个必须知道的限制

- **口令忘了就是忘了。** 没有找回、没有重置、没有客服。口令不上传、不存储，
  只在你这台浏览器里参与一次运算。
- **GitHub 不是网盘。** 单文件上限 100MB，仓库总量建议控制在 1GB 以内。
  更大的文件会自动改走 Release 资产通道（单文件上限 2GB），但仓库越大越难维护。
- **上传下载都要等几十秒。** 文件由 GitHub Actions 搬运一趟，
  不是直传。这是为了换取「存储侧的高权限凭据永不出现在浏览器里」。

## 它不做什么

- 不引任何第三方库、不用 CDN、不用外部字体或图标包。整个页面由
  `index.html` + `css/style.css` + `css/fx-plus.css` + 10 个 `js/*.js`
  组成，全部同源静态文件（文件清单以 `index.html` 的引用为准）。
- 不在浏览器里保存你的口令。
- 不做在线预览、不做分享链接、不做多用户。

## 加密方式

AES-GCM 256 位，口令经 PBKDF2-SHA256（25 万次迭代）派生密钥。
文件分块加密，每块独立的随机 nonce，并把块序号放进 GCM 的附加校验数据——
缺块、重排、截断都会在解密时直接报错，不会静默给你半个文件。


## API

站外只有一个只读的静态清单：

```
https://liuyiming2024.github.io/Cloud/api/manifest.json
```

GitHub Pages 是纯静态托管，没有服务端可以代理读写请求，
因此**不存在任何站外可调用的写入接口**。

页面内有一套编程接口 `Cloud.api`，供同源的其他页面或控制台脚本使用。
它能做的事与界面上的按钮完全相同，不会更多——它拿不到私有存储库的地址，
也拿不到那枚高权限令牌：

```js
await Cloud.api.init();
const files = await Cloud.api.list();
const id = await Cloud.api.upload(file);
const blob = await Cloud.api.download(id);
const off = Cloud.api.on('change', () => Cloud.api.list());
```

清单里的 `pageApi` 一节是完整方法表。改动接口后跑一次
`node scripts/check-api.js .` —— 它会核对清单里声明的路径和方法是否真的存在，
防止清单说谎。

## 许可

保留所有权利。这是一个个人项目，不提供复刻与二次部署指南。

## fx-plus 是集群权威源

`css/fx-plus.css` 与 `js/fx-plus.js` 是视觉效果层的**权威源**：
主页 `liuyiming2024.github.io`（内联生成 + `--check-upstream`）、
`Chat`（`assets/`）、`Code`（`css/` + `js/`）都从这两份复制。

改这里之后，主页 / Chat / Code 的 CI 都会红，按提示把副本同步过去即可；
不要反过来改副本 —— 那样只会让四份越差越远。

## 后端 Worker：写好了，刻意未启用

`worker/drive.js`（Cloudflare Worker）与 `worker/部署.md` 是完整的后端方案：
启用后令牌放在 Worker 的 Secrets 里，浏览器从头到尾拿不到也不需要，
游客打开页面什么都不用填，配额也由服务端真正拦截。

**但 `js/config.js` 的 `worker: ''` 是刻意的，不是漏配。**
当前走浏览器直连 GitHub：页面要求用户自己填一枚有
`contents: write` + `actions: write` 的 PAT，功能完整，也没有任何欺骗。
启用 Worker 需要先部署、配 4 个 Secrets、确认 Supabase 的 `whoami()`
仍在 anon 白名单里、再把地址填进配置 —— 属于部署动作，用户 2026-11-15
明确不切换，维持现状。

要启用时照 `worker/部署.md` 三步走即可；结论与理由见
`Tool/threads/决策记录.md` 第 2 条。
