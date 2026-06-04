// server.js — 정적 프론트 서빙 + /api/keywords (실시간 크롤링) + /api/history (시계열)
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crawlAll } from './crawler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 5분 자동 갱신에 맞춰 캐시 (직전 크롤링과 비교해 "5분증감" 산출)
const CACHE_TTL = 280 * 1000;
// 히스토리 적재 간격 (강제 새로고침해도 이 간격 내엔 중복 적재 안 함). 테스트 시 env로 단축 가능.
const HISTORY_INTERVAL = (+process.env.HISTORY_INTERVAL_SEC || 300) * 1000;
const HISTORY_MAX = 576;   // 5분 * 576 ≈ 48시간

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

let cache = null;          // 마지막으로 만든 스냅샷(가공 완료)
let cacheTime = 0;
let prevScores = {};       // { sourceKey: { keyword: score } } — 직전 크롤링 점수
let presence = {};         // { sourceKey: { keyword: { streak, rank } } } — 순위 유지/변동 추적
let history = [];          // [{ t, sources: { key: [[keyword, rank, score], ...] } }]
let lastHistoryTime = 0;

// 히스토리 로드/저장 ─────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (history.length) lastHistoryTime = new Date(history[history.length - 1].t).getTime();
    }
  } catch (e) { console.warn('history load 실패:', e.message); history = []; }
}
function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) { console.warn('history save 실패:', e.message); }
}

// 순위 기반 기본 점수 곡선 (1위≈10000)
const baseScore = (rank) => 10000 / Math.pow(rank, 0.62);

// 키워드 → 의미있는 토큰들 (공백 분리 + 2자 이상)
function tokensOf(keyword) {
  return keyword
    .replace(/[\[\]"'…·,.()\-~%!?："“”‘’]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^(속보|단독|종합|영상|현장|현장연결|현장영상)$/.test(t));
}

function buildSnapshot(raw) {
  const newPresence = {};
  const sources = raw.map((s) => {
    const prev = prevScores[s.key] || {};
    const prevPres = presence[s.key] || {};
    const isGoogle = s.key === 'google';
    // 구글: 근사 검색량의 최댓값(0~100 환산 기준)
    const maxRaw = isGoogle ? Math.max(1, ...s.items.map((it) => it.raw || 0)) : 1;

    const scored = s.items.map((it, i) => {
      const rank = i + 1;
      const kw = it.keyword;
      let score;
      if (isGoogle && it.raw > 0) {
        // 구글 = 실제 근사 검색량 → 상대 관심도 0~100 (최상위=100)
        score = Math.max(1, Math.round((it.raw / maxRaw) * 100));
      } else {
        // 그 외 = 순위 기본점수 + 순위 유지 시간(streak) + 순위 변동 폭 가중
        const base = baseScore(rank);
        const p = prevPres[kw];
        const streak = p ? p.streak : 1;
        const holdBonus = base * 0.04 * Math.min(streak - 1, 10);          // 오래 머물수록 가산
        let moveBonus = 0;
        if (p) moveBonus = base * 0.05 * Math.max(-3, Math.min(6, p.rank - rank)); // 상승 시 가산, 하락 시 소폭 감점
        score = Math.max(100, Math.round(base + holdBonus + moveBonus));
      }
      const isNew = !(kw in prev);
      const delta = isNew ? score : score - prev[kw];
      return { rank, keyword: kw, raw: it.raw, score, delta, isNew };
    });

    const total = scored.reduce((a, b) => a + b.score, 0) || 1;
    scored.forEach((it) => { it.ratio = +((it.score / total) * 100).toFixed(1); });

    // 순위 유지/변동 추적 갱신
    newPresence[s.key] = {};
    scored.forEach((it) => {
      const p = prevPres[it.keyword];
      newPresence[s.key][it.keyword] = { streak: p ? p.streak + 1 : 1, rank: it.rank };
    });

    return { ...s, items: scored };
  });
  presence = newPresence;

  // 다음 비교를 위해 점수 저장
  const next = {};
  sources.forEach((s) => {
    next[s.key] = {};
    s.items.forEach((it) => { next[s.key][it.keyword] = it.score; });
  });
  prevScores = next;

  // 교차 키워드: 2개 이상 매체에 등장하는 토큰
  const tokenMap = new Map();
  sources.forEach((s) => {
    if (!s.ok) return;
    s.items.forEach((it) => {
      for (const tok of new Set(tokensOf(it.keyword))) {
        if (!tokenMap.has(tok)) tokenMap.set(tok, new Map());
        const m = tokenMap.get(tok);
        if (!m.has(s.key)) m.set(s.key, { key: s.key, label: s.label, rank: it.rank });
      }
    });
  });
  const cross = [];
  for (const [token, m] of tokenMap) {
    if (m.size >= 2) {
      cross.push({ keyword: token, count: m.size, appearances: [...m.values()].sort((a, b) => a.rank - b.rank) });
    }
  }
  cross.sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword, 'ko'));

  // 토크나이저 칩
  const chips = [];
  sources.forEach((s) => {
    if (!s.ok) return;
    s.items.forEach((it) => {
      chips.push({ keyword: it.keyword, source: s.key, label: s.label, rank: it.rank, tokens: [...new Set(tokensOf(it.keyword))] });
    });
  });

  return { updatedAt: new Date().toISOString(), sources, cross: cross.slice(0, 30), chips };
}

// 스냅샷을 히스토리에 적재 (간격 제한)
function recordHistory(snap) {
  const now = Date.now();
  if (now - lastHistoryTime < HISTORY_INTERVAL) return;
  const entry = { t: snap.updatedAt, sources: {} };
  snap.sources.forEach((s) => {
    if (s.ok) entry.sources[s.key] = s.items.map((it) => [it.keyword, it.rank, it.score]);
  });
  history.push(entry);
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  lastHistoryTime = now;
  saveHistory();
}

app.get('/api/keywords', async (req, res) => {
  const force = req.query.force === '1';
  const now = Date.now();
  if (!force && cache && now - cacheTime < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }
  try {
    const raw = await crawlAll();
    cache = buildSnapshot(raw);
    cacheTime = now;
    recordHistory(cache);
    res.json({ ...cache, cached: false });
  } catch (e) {
    if (cache) return res.json({ ...cache, cached: true, warn: String(e.message) });
    res.status(500).json({ error: String(e.message) });
  }
});

// 시계열: ?source=naver&limit=24 → 최근 N개 스냅샷(해당 매체)
app.get('/api/history', (req, res) => {
  const source = req.query.source;
  const limit = Math.min(+req.query.limit || 24, HISTORY_MAX);
  const slice = history.slice(-limit);
  if (source) {
    res.json(slice.map((e) => ({ t: e.t, items: (e.sources[source] || []).map(([keyword, rank, score]) => ({ keyword, rank, score })) })));
  } else {
    res.json(slice);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

loadHistory();
app.listen(PORT, () => {
  console.log(`▶ 실시간 검색어 모니터링  →  http://localhost:${PORT}  (history ${history.length}pt)`);
});
