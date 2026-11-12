// YouTube 中継サーバー
// - yt-dlp で動画のストリーム URL を解決
// - 動画/音声/サムネイルのバイト列をすべてこのサーバー経由で中継（ブラウザは Google に直接つながない）
// - Range リクエスト対応（シーク可能）。上流へは 10MB ずつ分割して取得し、YouTube 側の速度制限を回避

import express from 'express';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const YTDLP_EXTRA = (process.env.YTDLP_ARGS || '').split(' ').filter(Boolean); // 例: "--cookies cookies.txt"

// JS ランタイム指定（Docker イメージでは node）
if (process.env.YTDLP_JS_RUNTIME) YTDLP_EXTRA.push('--js-runtimes', process.env.YTDLP_JS_RUNTIME);

// cookie ファイル（Render の Secret File は読み取り専用なので、書き込める場所にコピーして使う）
const COOKIE_SRC = process.env.COOKIES_FILE || '/etc/secrets/cookies.txt';
if (fs.existsSync(COOKIE_SRC)) {
  const dst = '/tmp/yt-cookies.txt';
  fs.copyFileSync(COOKIE_SRC, dst);
  YTDLP_EXTRA.push('--cookies', dst);
  console.log('cookie ファイルを使用します');
}
const UPSTREAM_CHUNK = 10 * 1024 * 1024; // 上流から一度に取る量
const CACHE_TTL = 60 * 60 * 1000; // ストリーム URL は約6時間有効だが余裕をみて1時間

const app = express();
app.disable('x-powered-by');

// 動作確認用（認証なし）
app.get('/healthz', (req, res) => res.send('ok'));

// パスワード保護：環境変数 SITE_PASSWORD を設定すると有効（ユーザー名は何でもよい）
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
if (SITE_PASSWORD) {
  const expected = Buffer.from(SITE_PASSWORD);
  app.use((req, res, next) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString();
      const pass = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
      if (pass.length === expected.length && timingSafeEqual(pass, expected)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="relay", charset="UTF-8"');
    res.status(401).send('パスワードが必要です');
  });
}

// ---------- 動画 ID 抽出 ----------
const ID_RE = /^[\w-]{11}$/;

function extractId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (ID_RE.test(input)) return input;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1, 12);
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v');
    if (!id) {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

// ---------- yt-dlp ----------
function runYtdlp(id) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ['-J', '--no-warnings', '--no-playlist', ...YTDLP_EXTRA, `https://www.youtube.com/watch?v=${id}`],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').split('\n').find((l) => l.includes('ERROR')) || err.message;
          return reject(new Error(msg.replace(/^.*ERROR:\s*/, '').trim()));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('yt-dlp の出力を解析できませんでした'));
        }
      }
    );
  });
}

const cache = new Map(); // id -> { expires, info }
const pending = new Map(); // id -> Promise

function contentLengthOf(f) {
  if (f.filesize) return f.filesize;
  try {
    const clen = new URL(f.url).searchParams.get('clen');
    if (clen) return Number(clen);
  } catch {}
  return null;
}

function simplify(raw) {
  if (raw.is_live) throw new Error('ライブ配信には対応していません');
  const formats = new Map();
  for (const f of raw.formats || []) {
    if (!f.url || !String(f.protocol || '').startsWith('http')) continue; // m3u8 / dash マニフェストは除外
    if (f.format_note === 'storyboard') continue;
    const hasV = f.vcodec && f.vcodec !== 'none';
    const hasA = f.acodec && f.acodec !== 'none';
    if (!hasV && !hasA) continue;
    const size = contentLengthOf(f);
    if (!size) continue;
    formats.set(String(f.format_id), {
      id: String(f.format_id),
      url: f.url,
      headers: f.http_headers || {},
      ext: f.ext,
      vcodec: hasV ? f.vcodec : null,
      acodec: hasA ? f.acodec : null,
      height: f.height || null,
      fps: f.fps || null,
      abr: f.abr || null,
      tbr: f.tbr || null,
      size,
      mime: (hasV ? 'video/' : 'audio/') + (f.ext === 'webm' ? 'webm' : 'mp4'),
    });
  }
  return {
    id: raw.id,
    title: raw.title,
    uploader: raw.uploader || raw.channel || '',
    duration: raw.duration || null,
    description: raw.description || '',
    viewCount: raw.view_count ?? null,
    uploadDate: raw.upload_date || null,
    formats,
  };
}

async function getInfo(id, { fresh = false } = {}) {
  const hit = cache.get(id);
  if (!fresh && hit && hit.expires > Date.now()) return hit.info;
  if (pending.has(id)) return pending.get(id);
  const p = runYtdlp(id)
    .then((raw) => {
      const info = simplify(raw);
      cache.set(id, { expires: Date.now() + CACHE_TTL, info });
      return info;
    })
    .finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

// 古いキャッシュの掃除
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- クライアント向けの画質リスト ----------
function codecLabel(c) {
  if (!c) return '';
  if (c.startsWith('avc1')) return 'H.264';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'VP9';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('mp4a')) return 'AAC';
  if (c.startsWith('opus')) return 'Opus';
  return c.split('.')[0];
}

function buildOptions(info) {
  const all = [...info.formats.values()];
  const progressive = all
    .filter((f) => f.vcodec && f.acodec)
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .map((f) => ({ id: f.id, height: f.height, label: `${f.height}p（音声込み）`, mime: f.mime }));

  const video = all
    .filter((f) => f.vcodec && !f.acodec)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0))
    .map((f) => ({
      id: f.id,
      height: f.height,
      fps: f.fps,
      codec: codecLabel(f.vcodec),
      mime: f.mime,
      label: `${f.height}p${f.fps > 30 ? f.fps : ''} ${codecLabel(f.vcodec)}`,
    }));

  const audio = all
    .filter((f) => f.acodec && !f.vcodec)
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
    .map((f) => ({ id: f.id, codec: codecLabel(f.acodec), mime: f.mime, abr: f.abr }));

  return { progressive, video, audio };
}

// ---------- API ----------
app.get('/api/info', async (req, res) => {
  const id = extractId(req.query.url || req.query.v);
  if (!id) return res.status(400).json({ error: 'YouTube の URL または動画 ID を認識できませんでした' });
  try {
    const info = await getInfo(id);
    res.json({
      id: info.id,
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      description: info.description,
      viewCount: info.viewCount,
      uploadDate: info.uploadDate,
      thumbnail: `/thumb/${info.id}`,
      ...buildOptions(info),
    });
  } catch (e) {
    console.error(`[info] ${id}:`, e.message);
    res.status(502).json({ error: e.message || '動画情報の取得に失敗しました' });
  }
});

// ---------- ストリーム中継 ----------
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  let start, end;
  if (m[1] === '') {
    // 末尾 N バイト
    const n = Number(m[2]);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// 上流から [start, end] を分割取得して res に書き込む
async function pipeUpstream(fmt, start, end, res, signal) {
  let pos = start;
  while (pos <= end) {
    if (signal.aborted) return;
    const chunkEnd = Math.min(pos + UPSTREAM_CHUNK - 1, end);
    const up = await fetch(fmt.url, {
      headers: { ...fmt.headers, Range: `bytes=${pos}-${chunkEnd}` },
      signal,
    });
    if (up.status !== 206 && up.status !== 200) {
      const err = new Error(`upstream ${up.status}`);
      err.status = up.status;
      throw err;
    }
    for await (const chunk of up.body) {
      if (signal.aborted) return;
      pos += chunk.length;
      if (!res.write(chunk)) await once(res, 'drain');
    }
  }
}

app.get('/stream/:id/:fmt', async (req, res) => {
  const { id, fmt: fmtId } = req.params;
  if (!ID_RE.test(id)) return res.sendStatus(400);

  let info;
  try {
    info = await getInfo(id);
  } catch (e) {
    return res.status(502).send(e.message);
  }
  let fmt = info.formats.get(fmtId);
  if (!fmt) return res.sendStatus(404);

  const size = fmt.size;
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.sendStatus(416);
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  // 最初のチャンクを取得して成功してからヘッダーを返す（URL 失効時に再解決するため）
  let headersSent = false;
  const sendHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    res.status(range ? 206 : 200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', fmt.mime);
    res.setHeader('Content-Length', end - start + 1);
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Cache-Control', 'no-store');
  };

  const origWrite = res.write.bind(res);
  res.write = (chunk) => {
    sendHeaders();
    return origWrite(chunk);
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await pipeUpstream(fmt, start, end, res, ac.signal);
      if (!ac.signal.aborted) res.end();
      return;
    } catch (e) {
      if (ac.signal.aborted || e.name === 'AbortError') return;
      // まだ1バイトも返しておらず、URL 失効っぽい場合は再解決してリトライ
      if (!headersSent && attempt === 0 && (e.status === 403 || e.status === 410)) {
        console.warn(`[stream] ${id}/${fmtId}: ${e.message} → URL を再取得`);
        try {
          info = await getInfo(id, { fresh: true });
          fmt = info.formats.get(fmtId);
          if (fmt && fmt.size === size) continue;
        } catch {}
      }
      console.error(`[stream] ${id}/${fmtId}:`, e.message);
      if (!headersSent) res.sendStatus(502);
      else res.destroy();
      return;
    }
  }
});

// ---------- サムネイル中継 ----------
app.get('/thumb/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.sendStatus(400);
  for (const name of ['maxresdefault', 'hqdefault']) {
    try {
      const up = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
      if (!up.ok) continue;
      res.setHeader('Content-Type', up.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch {}
  }
  res.sendStatus(404);
});

// ---------- フロントエンド ----------
app.use(express.static(path.join(__dirname, 'public')));
// /watch?v=xxx や /youtu.be 風のパスでも同じページを返す（フロント側で自動読み込み）
app.get(['/watch', '/shorts/:id', '/:id([\\w-]{11})'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`▶ http://localhost:${PORT}`);
});
