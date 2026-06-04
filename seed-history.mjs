// seed-history.mjs — 시계열 UI 검증용 더미 히스토리 생성
// 실제 현재 키워드를 1회 크롤링한 뒤, 5분 간격 8개 스냅샷으로 순위를 자연스럽게 흔들어 저장.
// 실사용 시에는 서버가 5분마다 실제 스냅샷을 이어서 누적합니다.
import fs from 'node:fs';
import path from 'node:path';
import { crawlAll } from './crawler.js';

const scoreOf = (rank) => Math.round(10000 / Math.pow(rank, 0.62));
const raw = await crawlAll();

const N = 8;            // 스냅샷 개수
const STEP = 5 * 60e3;  // 5분 간격
const now = Date.now();
const history = [];

for (let s = 0; s < N; s++) {
  const t = new Date(now - (N - 1 - s) * STEP).toISOString();
  const entry = { t, sources: {} };
  for (const src of raw) {
    if (!src.ok) continue;
    // 키워드 순서를 스냅샷마다 살짝 섞어 순위 변동 연출 (결정적: 인덱스 기반)
    const kws = src.keywords.slice(0, 10).map((kw, i) => {
      const jitter = ((i * 7 + s * 3) % 5) - 2;       // -2..+2
      return { kw, sortKey: i + jitter * 0.4 };
    }).sort((a, b) => a.sortKey - b.sortKey).map((x) => x.kw);
    entry.sources[src.key] = kws.map((kw, i) => [kw, i + 1, scoreOf(i + 1)]);
  }
  history.push(entry);
}

const dir = path.join(process.cwd(), 'data');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
console.log(`seeded ${history.length} snapshots → data/history.json`);
console.log('naver sample t0:', history[0].sources.naver?.slice(0, 3));
