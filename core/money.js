// 金额一律用整数「分」，全程不碰浮点。

function parseDecimalToCents(text) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`鲸鲸看不清这个金额：${text}`);
  const yuan = Number(m[1]);
  const fen = m[2] ? Number((m[2] + '00').slice(0, 2)) : 0;
  const cents = yuan * 100 + fen;
  if (!Number.isSafeInteger(cents)) throw new Error(`金额太大了：${text}`);
  return cents;
}

/**
 * 把“11.5”“11块5”“5万”“200”这种写法变成整数分。
 * 金额是数字时按“元”解释。
 */
export function parseAmountToCents(raw) {
  if (raw === null || raw === undefined || raw === '') throw new Error('金额是空的');
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error('金额不是有效数字');
    return Math.round(raw * 100);
  }
  let text = String(raw).trim().replace(/[,，\s]/g, '').replace(/[￥¥]/g, '');
  if (!text) throw new Error('金额是空的');

  let scale = 1;
  if (text.endsWith('万')) {
    scale = 10000;
    text = text.slice(0, -1);
  }

  // 11块5 / 11元5 / 11块5毛
  let m = /^(\d+(?:\.\d+)?)[块元圆](\d)(?:毛|角)?$/.exec(text);
  if (m) return parseDecimalToCents(m[1]) + Number(m[2]) * 10;

  // 5毛 / 5角
  m = /^(\d+)[毛角]$/.exec(text);
  if (m) return Number(m[1]) * 10;

  text = text.replace(/[元块圆]/g, '');
  return parseDecimalToCents(text) * scale;
}

/** 余额类金额：允许负数、允许「欠 1500.2」「负 1500.2」这种写法。 */
export function parseSignedAmountToCents(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/[,，\s]/g, '');
    if (text.startsWith('欠')) return -parseAmountToCents(text.slice(1));
    if (text.startsWith('负')) return -parseAmountToCents(text.slice(1));
    if (/^[-−]/.test(text)) return -parseAmountToCents(text.slice(1));
    if (text.startsWith('+')) return parseAmountToCents(text.slice(1));
  }
  return parseAmountToCents(raw);
}

/** 分 -> "11.50"（固定两位小数，负数带减号） */
export function formatYuan(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('金额不是整数分');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${sign}${yuan}.${String(fen).padStart(2, '0')}`;
}

export function formatYuanWithUnit(cents) {
  return `${formatYuan(cents)} 元`;
}

export function sumCents(list) {
  return list.reduce((total, value) => total + value, 0);
}

/** 把放大 10000 倍的整数还原成 "1.2345"。 */
export function formatScaledInteger(value, decimals = 4) {
  if (!Number.isSafeInteger(value)) throw new Error('这个数不是整数');
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const unit = 10 ** decimals;
  return `${sign}${Math.floor(abs / unit)}.${String(abs % unit).padStart(decimals, '0')}`;
}

export function parseScaledInteger(raw, decimals = 4) {
  const text = String(raw).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`鲸鲸看不清这个数：${raw}`);
  const fractionRaw = match[2] || '';
  if (fractionRaw.length > decimals) throw new Error(`最多 ${decimals} 位小数：${raw}`);
  const fraction = fractionRaw.padEnd(decimals, '0');
  const value = Number(match[1]) * 10 ** decimals + (fraction ? Number(fraction) : 0);
  if (!Number.isSafeInteger(value)) throw new Error(`这个数太大了：${raw}`);
  return value;
}

