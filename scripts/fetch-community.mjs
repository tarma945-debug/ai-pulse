#!/usr/bin/env node
/* ============================================================
   社区热帖抓取器
   抓 Reddit / Hacker News / Product Hunt / GitHub Trending，
   合并去重后落到 community.js，供前端同源读取。

   为什么不在浏览器里实时拉：
   1. Reddit 匿名 .json 接口返回 403（network security block）
   2. reddit.com 无 Access-Control-Allow-Origin，浏览器跨域必挂
   3. Reddit 限流很凶，top 接口连发两个就 429
   所以改成「本地定时抓 → 静态文件 → 前端读同源文件」。

   传输层用 curl 而不是 Node fetch：
   Node 内置 fetch 默认不读 HTTP_PROXY，走代理要额外装 undici，不值得。
   curl 一句 -x 就搞定，还能自动跟重定向。

   用法：
     node scripts/fetch-community.mjs          抓取并写入 community.js
     node scripts/fetch-community.mjs --dry    只打印不写文件
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "community.js");
const DRY = process.argv.includes("--dry");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ---------- 网络层：curl ---------- */
/* 代理端口每次会话可能变，所以要探测。
   但不能只看「端口开着」——本机有一堆内部服务端口（WorkBuddy 自己的
   56765 / 56731 等）也是开着的，但它们不翻墙，请求会直接卡死。
   所以必须做一次真实连通性验证。

   探针 URL 的坑：一开始拿 reddit 当探针，结果 Reddit 限流返 429 时，
   探针误判「代理出不去」→ 降级直连 → Reddit 全挂。
   现在换成 Google 的 204 端点：它只走代理可达、不限流、响应极小。 */
let PROXY = null;

const PROBE_URL = "https://www.google.com/generate_204";

async function curlOnce(url, proxy, timeout) {
  const args = [
    "-s", "-o", "/dev/null",
    "--max-time", String(timeout),
    "-A", UA,
    "-w", "%{http_code}",
  ];
  if (proxy) args.push("-x", proxy);
  args.push(url);
  try {
    const { stdout } = await run("curl", args, { timeout: (timeout + 3) * 1000 });
    return Number(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

async function probeProxy() {
  /* 环境变量里的代理优先级最高，但同样要验证 */
  const env = (process.env.HTTPS_PROXY || process.env.https_proxy || "").replace(/\/$/, "");
  const candidates = [];
  if (env) candidates.push(env);
  ["7897", "7890", "1087", "8118", "6152"].forEach((p) => {
    const u = `http://127.0.0.1:${p}`;
    if (!candidates.includes(u)) candidates.push(u);
  });

  for (const c of candidates) {
    const port = new URL(c).port;
    /* 先看端口开没开，省得每个都等超时 */
    try {
      await run("nc", ["-z", "-G", "1", "127.0.0.1", port], { timeout: 3000 });
    } catch {
      continue;   /* 端口没开 */
    }
    /* 再做真实连通验证：204 或无正文的 200 都算通 */
    const code = await curlOnce(PROBE_URL, c, 12);
    if (code === 204 || code === 200) {
      console.log(`[代理探测] ${c} 可用（HTTP ${code}）`);
      return c;
    }
    console.log(`[代理探测] ${c} 端口开着但出不去（HTTP ${code}），跳过`);
  }
  console.log("[代理探测] 没有可用代理，走直连（Reddit 会抓不到）");
  return null;
}

/* useProxy=false 用于国内源，走直连更快 */
async function curl(url, { useProxy = true, timeout = 25 } = {}) {
  const args = [
    "-sL", "--max-time", String(timeout),
    "-A", UA,
    "-H", "Accept: application/atom+xml,application/xml,text/xml,application/json,text/html,*/*",
    "-H", "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8",
    "-w", "\\n__HTTP__%{http_code}",
  ];
  if (useProxy && PROXY) args.push("-x", PROXY);
  args.push(url);

  try {
    const { stdout } = await run("curl", args, { maxBuffer: 40 * 1024 * 1024, timeout: (timeout + 5) * 1000 });
    const m = stdout.match(/\n__HTTP__(\d+)$/);
    const code = m ? Number(m[1]) : 0;
    const body = m ? stdout.slice(0, m.index) : stdout;
    return { ok: code >= 200 && code < 300, code, body };
  } catch (e) {
    return { ok: false, code: 0, body: "", error: e.message };
  }
}

/* 带退避的重试：429 单独拉长等待，Reddit 对连续请求很敏感 */
async function get(url, { tries = 2, useProxy = true, timeout = 20 } = {}) {
  let last = { ok: false, code: 0, body: "" };
  /* 代理失败时自动降级直连再试 */
  const modes = useProxy && PROXY ? [true, false] : [useProxy];
  for (let i = 0; i < tries; i++) {
    for (const useP of modes) {
      const r = await curl(url, { useProxy: useP, timeout });
      last = r;
      if (r.ok) return r;
      if (r.code === 429) {
        await sleep(6000 + i * 6000);   /* 限流：等更久，别把 Reddit 惹毛 */
        continue;
      }
      if (r.code === 403 || r.code === 404) return r;  /* 再试也没用 */
      await sleep(600);
    }
  }
  return last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 读上一轮的 community.js，用于「某源这轮挂了就沿用旧数据」 */
function readPrev() {
  try {
    if (!fs.existsSync(OUT)) return null;
    const txt = fs.readFileSync(OUT, "utf8");
    const a = txt.indexOf("{");
    const b = txt.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    return JSON.parse(txt.slice(a, b + 1));
  } catch {
    return null;
  }
}

/* ---------- XML 小工具（不引依赖，够用就行） ---------- */
function unxml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const pick = (xml, tag) => (xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")) || [])[1] || "";
const pickAttr = (xml, tag, attr) =>
  unxml((xml.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"`, "i")) || [])[1] || "");

/* ---------- Reddit ---------- */
const SUBS = [
  { sub: "StableDiffusion", label: "Stable Diffusion", cat: "图像生成" },
  { sub: "comfyui",         label: "ComfyUI",         cat: "工作流" },
  { sub: "aivideo",         label: "AI Video",        cat: "视频生成" },
  { sub: "LocalLLaMA",      label: "LocalLLaMA",      cat: "开源模型" },
  { sub: "singularity",     label: "Singularity",     cat: "行业讨论" },
];

async function fetchReddit(item) {
  const { sub } = item;
  /* top/day 是社区认可度最高的，失败再退 new 兜最新 */
  for (const sortPath of ["top/.rss?t=day", "new/.rss"]) {
    const r = await get(`https://www.reddit.com/r/${sub}/${sortPath}`, { tries: 2 });
    if (!r.ok) continue;    const entries = r.body.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    if (!entries.length) continue;

    const posts = entries.map((e) => {
      const id = pick(e, "id").replace(/^t3_/, "").trim();
      const title = unxml(pick(e, "title"));
      const timeRaw = pick(e, "published") || pick(e, "updated");
      const content = unxml(pick(e, "content"));
      /* RSS 里的 content 是一大坨 HTML 表格，取纯文本前 180 字当摘要 */
      return {
        id: "reddit:" + id,
        source: "Reddit",
        sub: "r/" + sub,
        subLabel: item.label,
        cat: item.cat,
        title,
        url: id ? `https://www.reddit.com/r/${sub}/comments/${id}/` : `https://www.reddit.com/r/${sub}/`,
        author: (pick(e, "name") || "").replace("/u/", "").trim(),
        time: timeRaw,
        excerpt: content.slice(0, 180),
      };
    }).filter((p) => p.title && p.time && !isNaN(new Date(p.time).getTime()));

    await sleep(2500);
    return posts;
  }
  return [];
}

/* ---------- Hacker News（Algolia 按关键词+时间+热度筛） ---------- */
async function fetchHN() {
  const since = Math.floor((Date.now() - 3 * 864e5) / 1000);
  const queries = ["AI video", "video model", "diffusion model", "generative video"];
  const seen = new Set();
  const out = [];

  for (const q of queries) {
    /* 注意：numericFilters 里的逗号必须编码成 %2C，否则会被当成 URL 分隔符截断，
       查出来就是 0 条（踩过坑） */
    const filters = encodeURIComponent(`created_at_i>${since},points>5`);
    const url =
      "https://hn.algolia.com/api/v1/search_by_date?query=" + encodeURIComponent(q) +
      `&tags=story&numericFilters=${filters}&hitsPerPage=20`;
    const r = await get(url, { tries: 2 });
    if (!r.ok) continue;
    let data;
    try { data = JSON.parse(r.body); } catch { continue; }

    for (const h of data.hits || []) {
      if (!h.title || seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      out.push({
        id: "hn:" + h.objectID,
        source: "Hacker News",
        sub: "HN",
        subLabel: "Hacker News",
        cat: "行业讨论",
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        author: h.author || "",
        time: h.created_at,
        excerpt: h.story_text ? unxml(h.story_text).slice(0, 180) : "",
        points: h.points || 0,
        comments: h.num_comments || 0,
      });
    }
    await sleep(600);
  }
  return out;
}

/* ---------- Product Hunt ---------- */
async function fetchPH() {
  const r = await get("https://www.producthunt.com/feed", { tries: 2, useProxy: false });
  if (!r.ok) return [];
  const entries = r.body.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.map((e) => {
    const link = pickAttr(e, "link", "href");
    const title = unxml(pick(e, "title"));
    return {
      id: "ph:" + (link.split("/").filter(Boolean).pop() || title),
      source: "Product Hunt",
      sub: "PH",
      subLabel: "Product Hunt",
      cat: "产品发布",
      title,
      url: link,
      author: unxml(pick(e, "name")),
      time: pick(e, "published") || pick(e, "updated"),
      excerpt: unxml(pick(e, "content")).slice(0, 180),
    };
  }).filter((p) => p.title && p.url && !isNaN(new Date(p.time).getTime()));
}

/* ---------- GitHub Trending（只留 AI 相关） ---------- */
const AI_HINT = /\b(ai|llm|llms|diffusion|video|image|gen|genai|model|models|agent|comfy|flux|stable|sora|kling|wan|whisper|tts|voice|nerf|gaussian|3d)\b/i;

async function fetchGitHub() {
  const r = await get("https://github.com/trending?since=daily", { tries: 2, useProxy: false });
  if (!r.ok) return [];

  const blocks = r.body.match(/<article class="Box-row">[\s\S]*?<\/article>/g) || [];
  const out = [];
  for (const b of blocks) {
    const repo = (b.match(/<h2[\s\S]*?href="\/([^/"]+\/[^/"]+)"/) || [])[1];
    if (!repo) continue;
    const desc = unxml((b.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/) || [])[1] || "");
    const starsToday = Number(String((b.match(/([\d,]+)\s*stars today/) || [])[1] || "0").replace(/,/g, ""));
    const lang = unxml((b.match(/itemprop="programmingLanguage">([^<]*)</) || [])[1] || "");

    if (!AI_HINT.test(repo + " " + desc)) continue;

    out.push({
      id: "gh:" + repo,
      source: "GitHub",
      sub: "GH",
      subLabel: "GitHub Trending",
      cat: "开源项目",
      title: repo,
      url: "https://github.com/" + repo,
      author: repo.split("/")[0],
      time: new Date().toISOString(),
      excerpt: desc.slice(0, 180),
      points: starsToday,
      meta: lang,
    });
  }
  return out.slice(0, 20);
}

/* ---------- 排序 ---------- */
/* GitHub Trending 没有「发布时间」这个概念——上榜的都是今天在涨的仓库，
   时间戳只能记成抓取时刻。如果按时间算新鲜度，它们会永远满分，把真正
   有时效性的 Reddit/HN 讨论全压下去。所以 GitHub 单独按 star 增速打分，
   并在热度上设一个上限，保证它不会霸榜。 */
function hotScore(p) {
  if (p.source === "GitHub") {
    /* star 增速 0~1000+ 映射到 0.35~0.85，实际分布里通常 100~600 */
    const s = Math.min(1, Math.log10((p.points || 0) + 1) / 3);
    return Math.round((0.35 + s * 0.5) * 1000) / 1000;
  }
  const ageH = (Date.now() - new Date(p.time).getTime()) / 36e5;
  const fresh = Math.max(0, 72 - ageH) / 72;              /* 72 小时内线性衰减 */
  const pts = Math.min(1, Math.log10((p.points || 0) + 1) / 3);
  const srcW = p.source === "Hacker News" ? 1 : p.source === "Product Hunt" ? 0.8 : 0.92;
  return Math.round((fresh * 0.7 + pts * 0.3) * srcW * 1000) / 1000;
}

/* 榜单打散：不要让同一来源连续占满前半屏。
   按来源轮流取，各自内部保持热度序。 */
function interleave(list) {
  const buckets = new Map();
  for (const p of list) {
    if (!buckets.has(p.source)) buckets.set(p.source, []);
    buckets.get(p.source).push(p);
  }
  const order = [...buckets.keys()].sort(
    (a, b) => (buckets.get(b)[0]?.heat || 0) - (buckets.get(a)[0]?.heat || 0)
  );
  const out = [];
  let more = true;
  while (more) {
    more = false;
    for (const k of order) {
      const b = buckets.get(k);
      if (b.length) { out.push(b.shift()); more = true; }
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */
async function main() {
  PROXY = await probeProxy();
  console.log(`[社区抓取] 代理：${PROXY || "直连"}   模式：${DRY ? "试跑" : "写入"}`);
  const t0 = Date.now();

  /* Reddit 串行（限流），其他并行 */
  const sides = await Promise.allSettled([
    fetchHN(),
    fetchPH(),
    fetchGitHub(),
  ]);

  const redditAll = [];
  for (const s of SUBS) {
    const got = await fetchReddit(s);
    console.log(`  r/${s.sub} → ${got.length} 条`);
    redditAll.push(...got);
  }

  const hn = sides[0].status === "fulfilled" ? sides[0].value : [];
  const ph = sides[1].status === "fulfilled" ? sides[1].value : [];
  const gh = sides[2].status === "fulfilled" ? sides[2].value : [];
  console.log(`  Hacker News → ${hn.length} 条`);
  console.log(`  Product Hunt → ${ph.length} 条`);
  console.log(`  GitHub Trending → ${gh.length} 条`);

  /* 去重 */
  const map = new Map();
  for (const p of [...redditAll, ...hn, ...ph, ...gh]) {
    if (p.title && !map.has(p.id)) map.set(p.id, p);
  }
  let list = [...map.values()].filter((p) => {
    const t = new Date(p.time).getTime();
    return !isNaN(t) && t > Date.now() - 7 * 864e5;   /* 只留 7 天内 */
  });

  /* 兜底：某一源这轮全挂（限流/网络）时，把上一份文件里该源的旧数据接回来，
     别因为一次抓取失败就整块清空，页面上看起来像坏了。
     Reddit 尤其是重灾区——它限流最凶。 */
  const prev = readPrev();
  if (prev) {
    const gotSrc = new Set(list.map((p) => p.source));
    const carried = [];
    for (const src of ["Reddit", "Hacker News", "Product Hunt", "GitHub"]) {
      if (gotSrc.has(src)) continue;
      const olds = (prev.posts || []).filter(
        (p) => p.source === src && new Date(p.time).getTime() > Date.now() - 7 * 864e5
      );
      if (olds.length) {
        console.log(`  ⚠ ${src} 本轮抓取失败，沿用上次的 ${olds.length} 条`);
        carried.push(...olds);
      }
    }
    list.push(...carried);
  }

  list.forEach((p) => { p.heat = hotScore(p); });
  list.sort((a, b) => b.heat - a.heat);
  /* 「全部」视图里按来源轮流排，避免一屏全是同一家 */
  list = interleave(list).slice(0, 240);

  const byCat = {};
  const bySource = {};
  for (const p of list) {
    byCat[p.cat] = (byCat[p.cat] || 0) + 1;
    bySource[p.source] = (bySource[p.source] || 0) + 1;
  }

  const payload = {
    site: {
      title: "社区热帖",
      desc: "Reddit / Hacker News / Product Hunt / GitHub 上 AI 创作圈的真实讨论",
      fetched: new Date().toISOString(),
      count: list.length,
      byCat,
      bySource,
    },
    posts: list,
  };

  if (DRY) {
    console.log("\n--- 热度前 12 条 ---");
    list.slice(0, 12).forEach((p, i) => {
      console.log(`${String(i + 1).padStart(2)}. [${p.source}/${p.sub}] ${p.title.slice(0, 58)}  heat=${p.heat}`);
    });
    console.log(`\n来源分布：${JSON.stringify(bySource)}`);
    console.log(`分类分布：${JSON.stringify(byCat)}`);
    console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（未写文件）`);
    return;
  }

  if (!list.length) {
    console.error("\n❌ 一条都没抓到，保留旧文件不动");
    process.exit(2);
  }

  const js =
    "/* 由 scripts/fetch-community.mjs 自动生成，请勿手改。\n" +
    `   抓取时间 ${payload.site.fetched}   共 ${list.length} 条 */\n` +
    "window.COMMUNITY_DATA = " + JSON.stringify(payload, null, 2) + ";\n";

  fs.writeFileSync(OUT, js, "utf8");
  console.log(`\n✅ 写入 ${path.basename(OUT)}  ${list.length} 条  ${(js.length / 1024).toFixed(1)}KB`);
  console.log(`   来源：${JSON.stringify(bySource)}`);
  console.log(`   分类：${JSON.stringify(byCat)}`);
  console.log(`   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("抓取失败：", e);
  process.exit(1);
});
