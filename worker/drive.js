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
const OID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(req, env) {
    // 跨域：页面在 github.io，Worker 在 workers.dev，必须放行
    if (req.method === 'OPTIONS') return preflight();

    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    const json = (obj, code = 200) =>
      new Response(JSON.stringify(obj), { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });
    const err = (msg, code = 400) => json({ ok: false, error: msg }, code);

    try {
      if (!env.DRIVE_PAT) return err('Worker 未配置 DRIVE_PAT', 500);
      const repo = env.DRIVE_REPO || 'liuyiming2024/Cloud_file';
      const gh = new GitHub(env.DRIVE_PAT, repo);

      const oid = url.searchParams.get('oid') || '';
      if (!OID_RE.test(oid)) return err('缺少或不合法的归属标识');

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
          kid: meta.kid || '', fp: meta.fp || '', oid,
          at: new Date().toISOString()
        }]);
        await gh.writeIndex(idx);
        return json({ ok: true, id, store, cipher: body.byteLength });
      }

      // 下载
      if (url.pathname === '/api/get' && req.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        if (!OID_RE.test(id)) return err('缺少或不合法的文件 id');
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

function preflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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
