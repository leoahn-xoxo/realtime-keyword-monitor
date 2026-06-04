// app.js — 데이터 fetch, 렌더링, 5분 자동 갱신, 토크나이저/예측, 교차 키워드

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 5 * 60 * 1000;

// 매체별 검색 URL (키워드 클릭 시 새 탭으로 이동)
const SEARCH_URL = {
  naver:  (q) => `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  zum:    (q) => `https://search.zum.com/search.zum?query=${encodeURIComponent(q)}`,
  nate:   (q) => `https://search.daum.net/nate?w=tot&q=${encodeURIComponent(q)}`,
  daum:   (q) => `https://search.daum.net/search?w=tot&q=${encodeURIComponent(q)}`,
};
const SRC_COLOR = { naver: '#08c75a', google: '#4285f4', zum: '#f1730a', nate: '#e23744', daum: '#7c4ddb' };
const SOURCES = [
  { key: 'naver', label: '네이버' }, { key: 'google', label: '구글' },
  { key: 'nate', label: '네이트' }, { key: 'daum', label: '다음' },
];

let snapshot = null;
let refreshTimer = null;
let tsSource = 'naver';   // 현재 선택된 시계열 매체
let tsChart = null;

function openSearch(source, keyword) {
  const make = SEARCH_URL[source];
  if (make) window.open(make(keyword), '_blank', 'noopener');
}

const fmt = (n) => n.toLocaleString('ko-KR');
const pad = (n) => String(n).padStart(2, '0');

function timeStr(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function deltaCell(it) {
  if (it.isNew || it.delta > 0) return `<span class="delta up">▲${fmt(it.isNew ? it.score : it.delta)}</span>`;
  if (it.delta < 0) return `<span class="delta down">▼${fmt(Math.abs(it.delta))}</span>`;
  return `<span class="delta same">-</span>`;
}

function renderColumns(sources) {
  const html = sources.map((s) => {
    const body = s.ok
      ? `<div class="rows">${s.items.map((it) => `
          <div class="row" data-kw="${escapeAttr(it.keyword)}" data-src="${s.key}">
            <span class="rank">${it.rank}</span>
            <span class="kw" title="${escapeAttr(it.keyword)}"><span class="dot"></span>${escapeHtml(it.keyword)}</span>
            <span class="score">${fmt(it.score)}</span>
            ${deltaCell(it)}
            <span class="ratio">${it.ratio}%</span>
          </div>`).join('')}</div>`
      : `<div class="col-error">크롤링 실패<br><small>${escapeHtml(s.error || '')}</small></div>`;
    return `
      <div class="col" data-src="${s.key}">
        <div class="col-head"><span>${s.label}</span><span class="sub">${s.sub}</span></div>
        <div class="col-subhead"><span>키워드</span><span class="r">지수</span><span class="r">5분증감</span><span class="r">비중</span></div>
        ${body}
      </div>`;
  }).join('');
  $('#columns').innerHTML = html;

  document.querySelectorAll('.row').forEach((row) => {
    row.addEventListener('click', () => openSearch(row.dataset.src, row.dataset.kw));
  });
}

function renderTokenizer(chips) {
  $('#tokenizer').innerHTML = chips.map((c, i) => `
    <button class="chip" data-src="${c.source}" data-idx="${i}">
      ${escapeHtml(c.keyword)}<span class="rk">${c.label} ${c.rank}위</span>
    </button>`).join('');
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => selectKeyword(chips[+chip.dataset.idx].keyword, chip));
  });
}

// 연관 키워드 = 토큰을 공유하는 다른 키워드. 예측 = 가장 빈번히 함께 등장하는 토큰.
function selectKeyword(keyword, chipEl) {
  if (!snapshot) return;
  const chips = snapshot.chips;
  const self = chips.find((c) => c.keyword === keyword);
  if (!self) return;

  document.querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
  if (chipEl) chipEl.classList.add('active');

  const myTokens = new Set(self.tokens);
  const related = chips
    .filter((c) => c.keyword !== keyword && c.tokens.some((t) => myTokens.has(t)))
    .map((c) => ({ ...c, shared: c.tokens.filter((t) => myTokens.has(t)) }));

  // 예측: 연관 키워드에서 가장 자주 나오는 (내 키워드에 없는) 토큰
  const freq = new Map();
  related.forEach((c) => c.tokens.forEach((t) => {
    if (!myTokens.has(t)) freq.set(t, (freq.get(t) || 0) + 1);
  }));
  const predict = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const box = $('#prediction');
  box.hidden = false;
  box.innerHTML = `
    <h3>“${escapeHtml(keyword)}” 연관 분석 → 다음 예측 키워드: ${
      predict.length ? predict.map(([t]) => `<b>${escapeHtml(t)}</b>`).join(', ') : '<b>예측 데이터 부족</b>'
    }</h3>
    <div class="related">
      ${related.length
        ? related.slice(0, 18).map((c) => `<span class="rel"><b>${escapeHtml(c.keyword)}</b> · ${c.label} ${c.rank}위</span>`).join('')
        : '<span class="rel">연관 키워드 없음</span>'}
    </div>
    <p class="note">※ 토큰 공유 기반 연관 분석입니다. ${related.length}개 키워드가 “${escapeHtml(keyword)}”와(과) 토큰을 공유합니다.</p>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderCross(cross) {
  $('#cross-count').textContent = cross.length;
  if (!cross.length) {
    $('#cross').innerHTML = `<span class="cross-empty">현재 2개 이상 매체에 공통 등장하는 키워드가 없습니다.</span>`;
    return;
  }
  $('#cross').innerHTML = cross.map((c) => `
    <div class="cross-card">
      <span class="ckw">${escapeHtml(c.keyword)}</span>
      <span class="cmeta">${c.count}매체</span>
      <span class="badges">${c.appearances.map((a) =>
        `<span class="cross-badge" data-src="${a.key}">${a.label} ${a.rank}위</span>`).join('')}</span>
    </div>`).join('');
}

// ── 시계열 (그래프 + 표) ─────────────────────────
function renderTsTabs() {
  $('#ts-tabs').innerHTML = SOURCES.map((s) =>
    `<button class="ts-tab ${s.key === tsSource ? 'active' : ''}" data-src="${s.key}">${s.label}</button>`).join('');
  document.querySelectorAll('.ts-tab').forEach((tab) => {
    tab.addEventListener('click', () => { tsSource = tab.dataset.src; renderTsTabs(); loadTimeSeries(); });
  });
}

const hhmm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

async function loadTimeSeries() {
  let hist;
  try {
    const r = await fetch(`/api/history?source=${tsSource}&limit=24`);
    hist = await r.json();
  } catch { return; }

  if (!hist.length) {
    $('#ts-note').textContent = '아직 시계열 데이터가 없습니다. 첫 스냅샷은 페이지 로드 시 적재되며, 이후 5분 간격으로 누적됩니다.';
    if (tsChart) { tsChart.destroy(); tsChart = null; }
    $('#ts-table').innerHTML = '';
    return;
  }

  const labels = hist.map((e) => hhmm(e.t));
  // 가장 최근 스냅샷의 상위 8개 키워드를 추적 대상으로
  const latest = hist[hist.length - 1].items.slice(0, 8);
  const tracked = latest.map((it) => it.keyword);

  // 키워드별 시계열 (지수 / 순위) 정렬
  const series = tracked.map((kw) => {
    const scores = hist.map((e) => { const f = e.items.find((i) => i.keyword === kw); return f ? f.score : null; });
    const ranks = hist.map((e) => { const f = e.items.find((i) => i.keyword === kw); return f ? f.rank : null; });
    return { kw, scores, ranks };
  });

  drawChart(labels, series);
  drawTable(labels, series);
  $('#ts-note').textContent = `${hist.length}개 스냅샷 · ${tracked.length}개 키워드 추적 (지수=라인, 표=순위). 표의 셀은 해당 시각 순위입니다.`;
}

function drawChart(labels, series) {
  const ctx = $('#ts-chart').getContext('2d');
  const palette = ['#08c75a', '#f1730a', '#e23744', '#7c4ddb', '#4aa3ff', '#ffd34d', '#ff7ab6', '#6ee7b7'];
  const datasets = series.map((s, i) => ({
    label: s.kw.length > 16 ? s.kw.slice(0, 16) + '…' : s.kw,
    data: s.scores,
    borderColor: palette[i % palette.length],
    backgroundColor: palette[i % palette.length] + '22',
    tension: 0.3, spanGaps: true, pointRadius: 2, borderWidth: 2,
  }));
  if (tsChart) tsChart.destroy();
  tsChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b9bb1', boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { title: (t) => t[0].label } },
      },
      scales: {
        x: { ticks: { color: '#5f7088', font: { size: 11 } }, grid: { color: '#1a2433' } },
        y: { ticks: { color: '#5f7088', font: { size: 11 } }, grid: { color: '#1a2433' }, title: { display: true, text: '지수', color: '#5f7088' } },
      },
    },
  });
}

function drawTable(labels, series) {
  const head = `<tr><th class="kw-col">키워드</th>${labels.map((l) => `<th>${l}</th>`).join('')}</tr>`;
  const rows = series.map((s) => {
    const cells = s.ranks.map((rk, i) => {
      if (rk == null) return `<td class="empty">-</td>`;
      const prev = s.ranks[i - 1];
      let arrow = '';
      if (prev != null && prev !== rk) arrow = rk < prev ? `<span class="up"> ▲${prev - rk}</span>` : `<span class="down"> ▼${rk - prev}</span>`;
      return `<td><span class="rk">${rk}위${arrow}</span></td>`;
    }).join('');
    const safe = escapeHtml(s.kw);
    return `<tr><td class="kw-col" title="${safe}" data-kw="${safe}">${safe}</td>${cells}</tr>`;
  }).join('');
  $('#ts-table').innerHTML = head + rows;
  // 표의 키워드 클릭 → 해당 매체 검색
  $('#ts-table').querySelectorAll('td.kw-col').forEach((td) => {
    td.style.cursor = 'pointer';
    td.addEventListener('click', () => openSearch(tsSource, td.dataset.kw));
  });
}

async function load(force = false) {
  const btn = $('#btn-refresh');
  btn.classList.add('loading');
  try {
    const res = await fetch(`/api/keywords${force ? '?force=1' : ''}`);
    if (!res.ok) throw new Error(`서버 오류 ${res.status}`);
    snapshot = await res.json();
    renderColumns(snapshot.sources);
    renderTokenizer(snapshot.chips);
    renderCross(snapshot.cross);
    $('#updated-at').textContent = timeStr(snapshot.updatedAt);
    loadTimeSeries();
    if (snapshot.warn) toast(`일부 갱신 경고: ${snapshot.warn}`);
  } catch (e) {
    toast(`불러오기 실패: ${e.message}`);
  } finally {
    btn.classList.remove('loading');
  }
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

$('#btn-refresh').addEventListener('click', () => load(true));
$('#btn-cross').addEventListener('click', () => $('.panel:last-of-type').scrollIntoView({ behavior: 'smooth' }));

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => load(true), REFRESH_MS);
}

renderTsTabs();
load();
startAutoRefresh();
