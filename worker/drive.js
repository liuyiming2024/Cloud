/**
 * Cloud Drive · 后端（Cloudflare Worker）
 *
 * 它就是那个"后端存密钥"的地方。
 *
 * 游客打开页面，什么都不用填 —— 令牌放在 Worker 的 Secrets 里，
 * 浏览器从头到尾看不到它，也不需要它。
 *
 * 部署后填两个 Secrets：
 *   DRIVE_PAT    能读写私有存储库的令牌
 *   DRIVE_REPO   私有存储库名，如 liuyiming2024/Cloud_file
 *
 * 存储仍然用 GitHub 私有库：小文件走 Contents API，大文件走 Release 资产。
 * 索引是私有库里的 index.json。
 */

const MAX_DIRECT = 20 * 1024 * 1024; // 20MB 以内走 Contents API。
                                     // 再大就在 Worker 里 base64 会吃满内存，改走 Release。

/* 访客配额。站长不限 —— 那是他自己的仓库。
 *
 * 为什么必须限：仓库是公摊的，不限的话一个人就能把它撑到没法维护
 * （git 历史只增不减，仓库一旦大了，clone 和 Actions 都会变慢）。
 *
 * 配额按"人"算，不按全站算：
 *   按全站算会出现"来得早的能用、来得晚的用不了"，而且先到的人占满之后，
 *   后来者连一个小文件都传不了。
 *
 * 这些值在 Worker 里改，前端那份只用于提前提示。 */
const GUEST_FILE_MAX = 100 * 1024 * 1024;      // 单文件 100MB
const GUEST_TOTAL_MAX = 1024 * 1024 * 1024;    // 总共 1GB

const OID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(req, env) {
    // 跨域：页面在 github.io，Worker 在 workers.dev，必须放行
    if (req.method === 'OPTIONS') return preflight();

    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Token'
    };
    const json = (obj, code = 200) =>
      new Response(JSON.stringify(obj), { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });
    const err = (msg, code = 400) => json({ ok: false, error: msg }, code);

    try {
      if (!env.DRIVE_PAT) return err('Worker 未配置 DRIVE_PAT', 500);

      /* 站长判定必须在后端做。
       *
       * 不能看请求里传的 oid —— 那东西谁都能改（就在浏览器 localStorage 里）。
       * 让人自己说"我是站长"然后据此放行，等于没设限。
       *
       * 所以：拿请求头里的令牌去**自建会话**验一次（x-session），
       * 验出来是谁就是谁，这个 uid 伪造不了。
       * 验不出身份的一律按访客处理，配额从紧。 */
      const who = await resolveIdentity(req, env);
      const ip = req.headers.get('CF-Connecting-IP') || '';

      // 不再对"令牌无效"做惩罚。
      // 自建会话下，无效和过期在服务端完全无法区分（都返回 null），
      // 罚下去就是精准打击刚过期的合法用户。
      const repo = env.DRIVE_REPO || 'liuyiming2024/Cloud_file';
      const gh = new GitHub(env.DRIVE_PAT, repo);

      const oid = url.searchParams.get('oid') || '';
      if (!OID_RE.test(oid)) return deny(ip, '没有权限');


      /* 归属校验。**必须对访客同样生效**。
       *
       * 之前写成 `who.uid && ...` —— 未带令牌时 who.uid 是 null，
       * 整条校验直接跳过。而 OID_RE 对 UUID 放行，
       * 于是任何不带令牌的请求只要知道目标 uid，
       * 就能 list（拿到全部文件 id）→ get 下载 → del 删除。
       *
       * 所以分三种情况，没有一种是"跳过"：
       *   站长     —— 能看所有人的（他本来就该能）
       *   已登录   —— 自己的 uid，或自己的匿名空间
       *   没身份   —— 只能是匿名空间（anon- 后跟 32 位随机十六进制，猜不出来） */
      if (!who.isOwner) {
        const isAnonSpace = oid.startsWith('anon-');
        if (who.uid) {
          if (oid !== who.uid && !isAnonSpace) return deny(ip, '没有权限');
        } else if (!isAnonSpace) {
          return deny(ip, '没有权限');
        }
      }

      // 列表
      if (url.pathname === '/api/list' && req.method === 'GET') {
        const idx = await gh.readIndex();
        return json({ ok: true, files: idx.files.filter((f) => f.oid === oid) });
      }

      // 上传。body 就是密文原文，不经过任何编码转换。
      if (url.pathname === '/api/put' && req.method === 'POST') {
        const id = url.searchParams.get('id') || '';
        if (!OID_RE.test(id)) return err('缺少或不合法的文件 id');
        const meta = decodeMeta(url.searchParams.get('meta'));
        const body = await req.arrayBuffer();
        if (!body.byteLength) return err('内容是空的');
        if (body.byteLength > 2 * 1024 * 1024 * 1024) return err('文件超过 2GB');

        const idx = await gh.readIndex();

        // 配额：站长不限，其余按人来算
        if (!who.isOwner) {
          if (body.byteLength > GUEST_FILE_MAX) {
            // 超配额是正常使用，不该罚 —— 用户可能真不知道上限在哪。
            // 但要说清楚差多少，否则他只能瞎猜该删多少。
            return err('单个文件最大 ' + mb(GUEST_FILE_MAX) + '，这个有 ' +
                       mb(body.byteLength), 413);
          }
          const used = idx.files.filter((f) => f.oid === oid)
                                .reduce((a, f) => a + (f.cipher || 0), 0);
          if (used + body.byteLength > GUEST_TOTAL_MAX) {
            return err('空间不够了：已用 ' + mb(used) + '，上限 ' + mb(GUEST_TOTAL_MAX) +
                       '，这个文件还差 ' + mb(used + body.byteLength - GUEST_TOTAL_MAX) +
                       '。删掉一些再传。', 413);
          }
        }

        if (meta.fp && idx.files.some((f) => f.fp === meta.fp)) {
          return err('已经有完全一样的内容了', 409);
        }

        let store = 'git';
        if (body.byteLength > MAX_DIRECT) {
          store = 'release';
          await gh.putAsset(oid + '__' + id + '.bin', body);
        } else {
          await gh.putFile('files/' + oid + '/' + id + '.bin', body, '存入 ' + id);
        }

        idx.files = idx.files.filter((f) => f.id !== id).concat([{
          id, name: meta.name || '', size: meta.size || 0,
          cipher: body.byteLength, store, km: meta.km || 'anon',
          kid: meta.kid || '', fp: meta.fp || '', proc: meta.proc || 0, oid,
          at: new Date().toISOString()
        }]);
        await gh.writeIndex(idx);
        return json({ ok: true, id, store, cipher: body.byteLength });
      }

      // 下载
      if (url.pathname === '/api/get' && req.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        if (!OID_RE.test(id)) return err('缺少或不合法的文件 id');
        /*
         * 不能只拿 oid 和 id 去拼路径 —— 那两个都是调用方给的。
         * 必须查索引确认"这个文件确实属于这个 oid"，
         * 否则知道别人 uid 就能直接读别人的文件（list 会把 id 一次性交出来）。
         */
        const idxG = await gh.readIndex();
        const hitG = idxG.files.find((f) => f.id === id);
        if (!hitG || hitG.oid !== oid) return deny(ip, '没有这个文件');
        let buf = await gh.getFile('files/' + oid + '/' + id + '.bin');
        if (!buf) buf = await gh.getAsset(oid + '__' + id + '.bin');
        if (!buf) return err('没有这个文件', 404);
        return new Response(buf, {
          headers: { ...cors, 'Content-Type': 'application/octet-stream' }
        });
      }

      // 删除
      if (url.pathname === '/api/del' && req.method === 'DELETE') {
        const id = url.searchParams.get('id') || '';
        if (!OID_RE.test(id)) return err('缺少或不合法的文件 id');
        const idx = await gh.readIndex();
        const hit = idx.files.find((f) => f.id === id);
        // 只能删自己的。oid 对不上就拒绝 —— 这是唯一的归属校验点，
        // Worker 不知道"谁是站长"，所以这里一视同仁：不是你的就不能删。
        if (!hit || hit.oid !== oid) return err('没有这个文件，或它不属于你', 404);
        await gh.delFile('files/' + oid + '/' + id + '.bin');
        await gh.delAsset(oid + '__' + id + '.bin');
        idx.files = idx.files.filter((f) => f.id !== id);
        await gh.writeIndex(idx);
        return json({ ok: true, id });
      }

      return err('不认识的请求', 404);
    } catch (e) {
      return err(String(e.message || e), 500);
    }
  }
};

/* ---------- 惩罚性延迟 ----------
 *
 * 为什么不让伪造请求立刻失败：
 *   立刻拒绝等于白送攻击者一个"对/错"应答器 ——
 *   他能在几秒内试几千个 uid、几千个伪造令牌，每次几毫秒就有答案。
 *   让他等一会儿再拒绝，每次尝试就有了成本，扫描效率会掉几个数量级。
 *
 * 为什么不是一小时：
 *   HTTP 请求根本等不了一小时 —— 客户端、浏览器、网关都会先断开，
 *   而一断，Cloudflare 就把这次调用整个取消：惩罚没落到他头上，
 *   反倒白占着我们自己的资源。想罚他，就得让他真的等到那个响应。
 *
 * 所以做成累进的：第一次几秒，越试越久，封顶 30 秒。
 * 次数记在 Cache API 里 —— 它不用额外绑定 KV，不增加部署步骤。
 */
const TARPIT = {
  base: 3000,      // 第一次 3 秒
  max: 30000,      // 最多 30 秒
  banAfter: 5,     // 再犯直接拒，不再陪他耗（否则反被拖住）
  ttl: 600         // 10 分钟没再犯就清零
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function strikeCount(ip) {
  const key = 'https://tarpit.invalid/' + (ip || 'unknown');
  let n = 0;
  try {
    const hit = await caches.default.match(key);
    if (hit) n = parseInt(await hit.text(), 10) || 0;
  } catch (e) { /* 记不到就当第一次 */ }
  return { n: n, key: key };
}

async function bumpStrike(s) {
  try {
    await caches.default.put(s.key, new Response(String(s.n + 1), {
      headers: { 'Cache-Control': 'public, max-age=' + TARPIT.ttl }
    }));
  } catch (e) { /* 记不上不影响本次拒绝 */ }
}

/* 可疑行为：等一会儿再拒。
   消息刻意含糊 —— 不说明是配额、是身份、还是格式问题，
   那等于在教他下次怎么改。 */
async function deny(ip, msg) {
  const s = await strikeCount(ip);
  await bumpStrike(s);
  if (s.n < TARPIT.banAfter) {
    await sleep(Math.min(TARPIT.base * Math.pow(2, s.n), TARPIT.max));
  }
  return err(msg || '没有权限', 403);
}

/* 字节数 → 人能读的大小 */
function mb(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + 'GB';
  if (n >= 1024 * 1024) return Math.round(n / 1024 / 1024) + 'MB';
  return Math.round(n / 1024) + 'KB';
}

/* 这个人是谁？
 *
 * 拿请求头里的 access_token 去 Supabase 验一次，验出 uid 就拿到了
 * **不可伪造**的身份 —— 伪造得有真令牌才行。
 *
 * 验不到（没带、过期、服务异常）就当访客，配额从紧。
 * 注意"服务异常"也按访客处理：宁可让站长临时受限，也不能在
 * 验证失败时放行 —— 那是把门开在失败分支上。 */
async function resolveIdentity(req, env) {
  const tok = req.headers.get('X-Access-Token') || '';
  const out = { isOwner: false, uid: null, role: null, badToken: false, configured: false };
  if (!env.SB_URL || !env.SB_KEY) return out;
  out.configured = true;
  if (!tok) return out;                 // 没带令牌 = 老实匿名，不算伪造

  /* 身份解析。三条约束，缺一条就是故障：
   *
   * ① 必须走**自建会话**（x-session 头），不是 Supabase GoTrue。
   *    全站会话是自己签发的（cur_token() 读 x-session），全库没用过 auth.uid()。
   *    拿自建令牌去问 /auth/v1/user 必然 401 —— 于是每个正常登录用户都被
   *    判成"伪造"然后 403，重试几次还被 tarpit 封掉。
   *
   * ② 必须调**白名单里的**函数。
   *    不能用 auth_uid() / auth_role() —— V-03 把 blanket grant 收窄成
   *    逐函数白名单后，这两个被显式 `revoke ... from public` 了。
   *    调它们会 403，uid 变 null，于是登录用户被降级成访客：
   *    既受 100MB/1GB 配额，又因"无身份只能访问 anon- 空间"
   *    连自己的 uid 空间都进不去 —— 完全不可用。
   *
   * ③ 所以改用 whoami()：它在白名单里（grant ... to anon, authenticated），
   *    一次调用同时返回 id / role / status，正是我们需要的。
   *
   * 关于"令牌无效"是否惩罚：自建会话下无效与过期在服务端无法区分
   * （都返回 ok:false），罚下去就是精准打击刚过期的合法用户，故不罚。
   * 伪造行为的拦截交给归属校验 —— 那才是真正拦得住的地方。 */
  try {
    const r = await fetch(env.SB_URL + '/rest/v1/rpc/whoami', {
      method: 'POST',
      headers: {
        apikey: env.SB_KEY,
        'x-session': tok,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (r.ok) {
      const j = await r.json();
      // whoami 区分了"没登录"和"会话有效但用户没了"，两种都按访客算，
      // 且都不惩罚 —— 都不是攻击信号。
      if (j && j.ok === true) {
        out.uid = j.id || null;
        out.role = j.role || null;
        // 站长由服务端给的角色判定，不靠一个配来的 uid —— 配置会漂移，
        // role 是库里的既成事实。
        out.isOwner = (j.role === 'owner');
      }
    }
  } catch (e) {
    // 验证出错 = 验不到身份，按访客算
  }
  return out;
}

function preflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Token',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function decodeMeta(b64) {
  if (!b64) return {};
  try {
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) {
    return {};
  }
}

/* ---------- GitHub 私有库读写 ---------- */
class GitHub {
  constructor(token, repo) {
    this.token = token;
    this.api = 'https://api.github.com/repos/' + repo;
    this.uploads = 'https://uploads.github.com/repos/' + repo;
  }

  async req(path, opts = {}) {
    const r = await fetch(this.api + path, {
      ...opts,
      headers: {
        Authorization: 'token ' + this.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {})
      }
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error((await r.json()).message || ('GitHub ' + r.status));
    return r;
  }

  async sha(path) {
    const r = await this.req('/contents/' + path + '?ref=main');
    if (!r) return null;
    return (await r.json()).sha || null;
  }

  async putFile(path, buf, msg) {
    // 差值：内容没变就不写。白写一次就是一个 commit，git 历史只增不减。
    const want = await gitBlobSha(buf);
    const have = await this.sha(path);
    if (have === want) return false;

    const body = { message: msg, content: base64(buf) };
    if (have) body.sha = have;
    const r = await this.req('/contents/' + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r) throw new Error('写入失败：' + path);
    return true;
  }

  async getFile(path) {
    const r = await fetch(this.api + '/contents/' + path + '?ref=main', {
      headers: {
        Authorization: 'token ' + this.token,
        Accept: 'application/vnd.github.raw'
      }
    });
    if (!r.ok) return null;
    return r.arrayBuffer();
  }

  async delFile(path) {
    const s = await this.sha(path);
    if (!s) return false;
    await this.req('/contents/' + path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '删除 ' + path, sha: s })
    });
    return true;
  }

  /* Release 通道：大文件 */
  async releaseId() {
    let r = await this.req('/releases/tags/latest');
    if (r) return (await r.json()).id;
    r = await this.req('/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: 'latest', name: 'drive', body: 'Cloud Drive 大文件' })
    });
    return (await r.json()).id;
  }

  async putAsset(name, buf) {
    const rid = await this.releaseId();
    await this.delAsset(name);
    const r = await fetch(this.uploads + '/releases/' + rid + '/assets?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: {
        Authorization: 'token ' + this.token,
        'Content-Type': 'application/octet-stream'
      },
      body: buf
    });
    if (!r.ok) throw new Error('大文件写入失败');
  }

  async getAsset(name) {
    const rid = await this.releaseId();
    const r = await this.req('/releases/' + rid + '/assets?per_page=100');
    if (!r) return null;
    const list = await r.json();
    const hit = list.find((a) => a.name === name);
    if (!hit) return null;
    const d = await fetch(this.api + '/releases/assets/' + hit.id, {
      headers: { Authorization: 'token ' + this.token, Accept: 'application/octet-stream' }
    });
    if (!d.ok) return null;
    return d.arrayBuffer();
  }

  async delAsset(name) {
    const rid = await this.releaseId();
    const r = await this.req('/releases/' + rid + '/assets?per_page=100');
    if (!r) return false;
    const list = await r.json();
    const hit = list.find((a) => a.name === name);
    if (!hit) return false;
    await this.req('/releases/assets/' + hit.id, { method: 'DELETE' });
    return true;
  }

  async readIndex() {
    const buf = await this.getFile('index.json');
    if (!buf) return { v: 1, files: [] };
    try {
      const j = JSON.parse(new TextDecoder().decode(buf));
      j.files = j.files || [];
      return j;
    } catch (e) {
      return { v: 1, files: [] };
    }
  }

  async writeIndex(idx) {
    await this.putFile('index.json', new TextEncoder().encode(JSON.stringify(idx)), '更新索引');
  }
}

/* base64：分块拼，避免大数组一次性进字符串 */
function base64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  }
  return btoa(s);
}

/* git blob sha1：和 GitHub 返回的 sha 同一算法，用来做差值判断 */
async function gitBlobSha(buf) {
  const u8 = new Uint8Array(buf);
  const head = new TextEncoder().encode('blob ' + u8.length + '\0');
  const all = new Uint8Array(head.length + u8.length);
  all.set(head, 0);
  all.set(u8, head.length);
  const d = await crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
