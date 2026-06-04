// crawler.js — 네이버/ZUM/네이트/다음 실시간 데이터 크롤러
// 추가 의존성 없이 Node 24 내장 fetch + TextDecoder(EUC-KR) 사용

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function getBuffer(url, referer) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': referer || url, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const decodeEUCKR = (buf) => new TextDecoder('euc-kr').decode(buf);
const decodeUTF8 = (buf) => buf.toString('utf8');

// HTML 엔티티 정리
function clean(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────
// 네이버 — 뉴스 많이 본 기사 랭킹 (EUC-KR)
// ─────────────────────────────────────────────────────────
async function crawlNaver() {
  const buf = await getBuffer('https://news.naver.com/main/ranking/popularDay.naver', 'https://www.naver.com/');
  const html = decodeEUCKR(buf);
  const seen = new Set();
  const items = [];
  for (const m of html.matchAll(/class="list_title[^"]*"[^>]*>([^<]+)</g)) {
    const title = clean(m[1]);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    items.push(title);
    if (items.length >= 15) break;
  }
  return items;
}

// ─────────────────────────────────────────────────────────
// ZUM — 실시간 검색어 (홈 HTML 내 real1_id 파싱)
// ─────────────────────────────────────────────────────────
async function crawlZum() {
  const buf = await getBuffer('https://zum.com/', 'https://zum.com/');
  const html = decodeUTF8(buf);
  const byRank = new Map();
  for (const m of html.matchAll(/query=([^&"']+)[^"']*?real1_id=(\d+)/g)) {
    const rank = +m[2];
    if (byRank.has(rank)) continue;
    let kw = m[1].replace(/&amp;/g, '&').replace(/\+/g, ' ');
    try { kw = decodeURIComponent(kw); } catch { /* keep raw */ }
    byRank.set(rank, clean(kw));
  }
  return [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([, kw]) => kw).slice(0, 15);
}

// ─────────────────────────────────────────────────────────
// 네이트 — 실시간 이슈 키워드 (EUC-KR JSON)
// 형식: [["순위","키워드","+/-/s/n","증감","짧은키워드"], ...]
// ─────────────────────────────────────────────────────────
async function crawlNate() {
  const buf = await getBuffer('https://www.nate.com/js/data/jsonLiveKeywordDataV1.js', 'https://www.nate.com/');
  const txt = decodeEUCKR(buf);
  const data = JSON.parse(txt);
  return data.map((row) => clean(String(row[1]))).filter(Boolean).slice(0, 15);
}

// ─────────────────────────────────────────────────────────
// 다음 — 뉴스 주요 기사 (UTF-8)
// ─────────────────────────────────────────────────────────
async function crawlDaum() {
  const buf = await getBuffer('https://news.daum.net/', 'https://www.daum.net/');
  const html = decodeUTF8(buf);
  const seen = new Set();
  const items = [];
  for (const m of html.matchAll(/class="[^"]*\btit[^"]*"[^>]*>\s*([^<]{4,60})</g)) {
    const t = clean(m[1]);
    if (!t || seen.has(t) || /로그인|뉴스|바로가기|더보기|페이지/.test(t)) continue;
    seen.add(t);
    items.push(t);
    if (items.length >= 15) break;
  }
  return items;
}

// ─────────────────────────────────────────────────────────
// 구글 — Google Trends 실시간 급상승 (공식 RSS, UTF-8)
// ─────────────────────────────────────────────────────────
async function crawlGoogle() {
  const buf = await getBuffer('https://trends.google.com/trending/rss?geo=KR', 'https://trends.google.com/');
  const xml = decodeUTF8(buf);
  const items = [];
  const seen = new Set();
  for (const block of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const m = block[1].match(/<title>([\s\S]*?)<\/title>/);
    if (!m) continue;
    const kw = clean(m[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    items.push(kw);
    if (items.length >= 15) break;
  }
  return items;
}

const SOURCES = [
  { key: 'naver', label: '네이버', sub: '뉴스 많이 본 기사', fn: crawlNaver },
  { key: 'google', label: '구글', sub: '실시간 급상승', fn: crawlGoogle },
  { key: 'nate', label: '네이트', sub: '실시간', fn: crawlNate },
  { key: 'daum', label: '다음', sub: '실시간', fn: crawlDaum },
];

// 모든 소스를 병렬 크롤링. 한 소스가 실패해도 나머지는 반환.
export async function crawlAll() {
  const results = await Promise.allSettled(SOURCES.map((s) => s.fn()));
  return SOURCES.map((s, i) => {
    const r = results[i];
    return {
      key: s.key,
      label: s.label,
      sub: s.sub,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
      keywords: r.status === 'fulfilled' ? r.value : [],
    };
  });
}
