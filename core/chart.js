// 图表：纯手绘 SVG，零第三方依赖，生成本地 HTML 报表。

import { monthlyReport } from './report.js';
import { todayInShanghai } from './ledger.js';
import { sumCents } from './money.js';

const COLORS = [
  '#4A90D9',
  '#5FC9C0',
  '#F2A6C2',
  '#F7C873',
  '#8E7CC3',
  '#6FBF73',
  '#E8836B',
  '#9BB7D4',
  '#C9A66B',
  '#7FB3D5',
];

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function shiftMonth(month, delta) {
  const [year, mon] = month.split('-').map(Number);
  const total = year * 12 + (mon - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = ((total % 12) + 12) % 12 + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

export function lastMonths(month, count) {
  return Array.from({ length: count }, (_, index) => shiftMonth(month, index - (count - 1)));
}

function emptySvg(message) {
  return `<svg viewBox="0 0 560 180" width="100%" role="img"><text x="280" y="95" text-anchor="middle" font-size="14" fill="#889">${esc(
    message,
  )}</text></svg>`;
}

function pieSvg(items) {
  const total = sumCents(items.map((item) => item.value));
  if (!total) return emptySvg('这个月还没有支出，饼图先空着～');

  const width = 470;
  const height = 270;
  const cx = 125;
  const cy = 135;
  const radius = 98;
  const parts = [];

  if (items.length === 1) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${items[0].color}"/>`);
  } else {
    let angle = -Math.PI / 2;
    for (const item of items) {
      const delta = (item.value / total) * Math.PI * 2;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(angle + delta);
      const y2 = cy + radius * Math.sin(angle + delta);
      const large = delta > Math.PI ? 1 : 0;
      parts.push(
        `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(
          2,
        )} ${y2.toFixed(2)} Z" fill="${item.color}" stroke="#ffffff" stroke-width="2"/>`,
      );
      angle += delta;
    }
  }

  const legend = items
    .map((item, index) => {
      const ratio = ((item.value / total) * 100).toFixed(1);
      return `<g transform="translate(252,${24 + index * 24})"><rect width="12" height="12" rx="3" fill="${
        item.color
      }"/><text x="20" y="10" font-size="13" fill="#334">${esc(item.label)} ${ratio}%</text></g>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${parts.join('')}${legend}</svg>`;
}

function barSvg(items) {
  if (!items.length) return emptySvg('还没有月度数据～');
  const width = 580;
  const rowHeight = 34;
  const top = 28;
  const left = 74;
  const right = 76;
  const height = top + items.length * rowHeight + 16;
  const max = Math.max(1, ...items.map((item) => item.value));

  const rows = items
    .map((item, index) => {
      const y = top + index * rowHeight;
      const barWidth = Math.max(2, (item.value / max) * (width - left - right));
      return `<g><text x="8" y="${y + 16}" font-size="13" fill="#334">${esc(item.label)}</text>
        <rect x="${left}" y="${y + 4}" width="${barWidth.toFixed(1)}" height="20" rx="6" fill="${
          COLORS[index % COLORS.length]
        }"/>
        <text x="${(left + barWidth + 8).toFixed(1)}" y="${y + 18}" font-size="12" fill="#556">${(
          item.value / 100
        ).toFixed(2)}</text></g>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${rows}</svg>`;
}

function stackedSvg(months, categories) {
  if (!categories.length || !months.length) return emptySvg('还没有类目数据～');

  const width = 620;
  const height = 340;
  const left = 64;
  const right = 24;
  const top = 24;
  const bottom = 68;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...months.map((month) => sumCents(month.values)));
  const slot = plotWidth / months.length;
  const barWidth = Math.min(46, slot * 0.55);

  const bars = months
    .map((month, monthIndex) => {
      const x = left + slot * monthIndex + (slot - barWidth) / 2;
      let cursor = top + plotHeight;
      const segments = month.values
        .map((value, categoryIndex) => {
          const segmentHeight = (value / max) * plotHeight;
          cursor -= segmentHeight;
          return `<rect x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barWidth.toFixed(
            1,
          )}" height="${Math.max(0, segmentHeight).toFixed(1)}" fill="${categories[categoryIndex].color}"/>`;
        })
        .join('');
      return `<g>${segments}<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 40}" text-anchor="middle" font-size="12" fill="#556">${esc(
        month.label,
      )}</text></g>`;
    })
    .join('');

  const legend = categories
    .map((category, index) => {
      const x = left + index * 92;
      return `<g transform="translate(${x},${height - 20})"><rect width="10" height="10" rx="2" fill="${
        category.color
      }"/><text x="15" y="9" font-size="11" fill="#445">${esc(category.name)}</text></g>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${bars}${legend}</svg>`;
}

export function buildChartHtml(store, options = {}) {
  const month = options.month || todayInShanghai().slice(0, 7);
  const months = options.months || 6;
  const current = monthlyReport(store, month);
  const monthList = lastMonths(month, months);
  const monthly = monthList.map((item) => monthlyReport(store, item));

  const pieItems = current.expenseRows
    .filter((row) => row.netCents > 0)
    .slice(0, 10)
    .map((row, index) => ({ label: row.name, value: row.netCents, color: COLORS[index % COLORS.length] }));

  const barItems = monthly.map((report) => ({ label: report.month.slice(5), value: report.expenseNetCents }));

  const totals = new Map();
  for (const report of monthly) {
    for (const row of report.expenseRows) {
      if (row.netCents > 0) totals.set(row.name, (totals.get(row.name) || 0) + row.netCents);
    }
  }
  const categories = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name], index) => ({ name, color: COLORS[index % COLORS.length] }));
  const stackedMonths = monthly.map((report) => ({
    label: report.month.slice(5),
    values: categories.map((category) => report.expenseRows.find((row) => row.name === category.name)?.netCents || 0),
  }));

  const tableRows = monthly
    .map(
      (report) =>
        `<tr><td>${report.month}</td><td>${(report.expenseGrossCents / 100).toFixed(2)}</td><td>${(
          report.refundAdjustCents / 100
        ).toFixed(2)}</td><td>${(report.expenseNetCents / 100).toFixed(2)}</td><td>${(
          report.incomeCents / 100
        ).toFixed(2)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲸鲸管家 · ${esc(month)} 报表</title>
<style>
  :root { --ink:#22323f; --muted:#6b7c8c; --line:#e3edf5; --card:#ffffff; --bg:#eef7fb; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:linear-gradient(180deg,#f7fcff,#eef7fb); color:var(--ink);
         font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; }
  header { display:flex; align-items:baseline; gap:12px; margin-bottom:18px; }
  header h1 { font-size:22px; margin:0; }
  header .sub { color:var(--muted); font-size:13px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px 18px;
          box-shadow:0 6px 24px rgba(74,144,217,.08); }
  .card h2 { font-size:15px; margin:0 0 10px; color:#2f5f8f; }
  .card.wide { grid-column: 1 / -1; }
  .kpis { display:flex; gap:24px; flex-wrap:wrap; margin-bottom:16px; }
  .kpi .label { color:var(--muted); font-size:12px; }
  .kpi .value { font-size:20px; font-weight:600; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:right; padding:7px 8px; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--muted); font-weight:500; }
  tbody tr:last-child td { border-bottom:none; }
  footer { margin-top:18px; color:var(--muted); font-size:12px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🐋 鲸鲸管家</h1>
    <div class="sub">${esc(month)} 报表 · 近 ${months} 个月 · 生成于 ${esc(todayInShanghai())}</div>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="label">本月支出（净额）</div><div class="value">${(current.expenseNetCents / 100).toFixed(
      2,
    )}</div></div>
    <div class="kpi"><div class="label">本月收入</div><div class="value">${(current.incomeCents / 100).toFixed(2)}</div></div>
    <div class="kpi"><div class="label">本月退款调整</div><div class="value">${(-current.refundAdjustCents / 100).toFixed(
      2,
    )}</div></div>
  </div>

  <div class="grid">
    <section class="card">
      <h2>类目占比（${esc(month)}）</h2>
      ${pieSvg(pieItems)}
    </section>
    <section class="card">
      <h2>月度支出（近 ${months} 个月）</h2>
      ${barSvg(barItems)}
    </section>
    <section class="card wide">
      <h2>类目 × 月（堆叠）</h2>
      ${stackedSvg(stackedMonths, categories)}
    </section>
    <section class="card wide">
      <h2>月度明细</h2>
      <table>
        <thead><tr><th>月份</th><th>支出毛额</th><th>退款调整</th><th>支出净额</th><th>收入</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </section>
  </div>

  <footer>鲸鲸管家 · 本地文件账本 · 图表由手绘 SVG 生成，不依赖任何图表库</footer>
</div>
</body>
</html>`;
}
