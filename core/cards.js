// 信用卡年费：扣费日、免年费笔数窗口、提醒、记账。

import { formatYuan, parseAmountToCents, sumCents } from './money.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { addDays, daysBetween } from './dates.js';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeSharedCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .map((card) => {
      if (!card || !card.name) return null;
      return {
        name: String(card.name).trim(),
        network: String(card.network || '').trim(),
        currency: String(card.currency || 'CNY').toUpperCase(),
      };
    })
    .filter(Boolean);
}

export function setCardPolicy(store, account, options = {}) {
  const existing = (account.meta && account.meta.credit_card) || {};
  const legacyDueDay = account.meta && Number.isInteger(account.meta.cardDueDay) ? account.meta.cardDueDay : null;
  const policy = {
    annualFeeCents: options.fee !== undefined ? parseAmountToCents(options.fee) : existing.annualFeeCents ?? null,
    feeMonth: options.feeMonth !== undefined ? Number(options.feeMonth) : existing.feeMonth ?? null,
    feeDay: options.feeDay !== undefined ? Number(options.feeDay) : existing.feeDay ?? null,
    waiverCount: options.waiverCount !== undefined ? Number(options.waiverCount) : existing.waiverCount ?? 0,
    statementDay:
      options.statementDay !== undefined ? Number(options.statementDay) : existing.statementDay ?? null,
    dueDay: options.dueDay !== undefined ? Number(options.dueDay) : existing.dueDay ?? legacyDueDay ?? null,
    limitCents: options.limit !== undefined ? parseAmountToCents(options.limit) : existing.limitCents ?? null,
    sharedCards:
      options.sharedCards !== undefined ? normalizeSharedCards(options.sharedCards) : existing.sharedCards || [],
    waivedYears: existing.waivedYears || [],
    chargedYears: existing.chargedYears || [],
  };

  if (policy.feeMonth !== null && !(policy.feeMonth >= 1 && policy.feeMonth <= 12)) {
    throw new Error('扣费月份要在 1 到 12 之间');
  }
  if (policy.feeDay !== null && !(policy.feeDay >= 1 && policy.feeDay <= 31)) {
    throw new Error('扣费日要在 1 到 31 之间');
  }
  if (policy.dueDay !== null && !(policy.dueDay >= 1 && policy.dueDay <= 31)) {
    throw new Error('还款日要在 1 到 31 之间');
  }
  if (policy.statementDay !== null && !(policy.statementDay >= 1 && policy.statementDay <= 31)) {
    throw new Error('账单日要在 1 到 31 之间');
  }
  if ((policy.feeMonth === null) !== (policy.feeDay === null)) {
    throw new Error('扣费月和扣费日要一起设');
  }

  if (!(account.tags || []).includes('credit_card')) account.tags = [...(account.tags || []), 'credit_card'];
  const sharedNames = policy.sharedCards.map((card) => card.name).filter(Boolean);
  if (sharedNames.length) {
    account.aliases = [...new Set([...(account.aliases || []), ...sharedNames])];
  }
  const meta = { ...(account.meta || {}), credit_card: policy };
  delete meta.cardDueDay;
  account.meta = meta;
  store.saveAccounts();
  store.audit({
    action: 'card-policy',
    accountId: account.id,
    policy,
    at: new Date().toISOString(),
  });
  return policy;
}

export function cardMetaText(account) {
  const policy = account.meta && account.meta.credit_card;
  if (!policy) return '这张卡还没设资料～';
  const lines = [];
  if (policy.dueDay) lines.push(`还款日：每月 ${policy.dueDay} 日`);
  if (policy.statementDay) lines.push(`账单日：每月 ${policy.statementDay} 日`);
  if (policy.limitCents) lines.push(`额度：${formatYuan(policy.limitCents)}`);
  if ((policy.sharedCards || []).length) {
    lines.push(
      `共享卡：${policy.sharedCards
        .map((card) => `${card.name}${card.network ? `（${card.network}）` : ''}${card.currency && card.currency !== 'CNY' ? ` ${card.currency}` : ''}`)
        .join('、')}`,
    );
  }
  if (policy.annualFeeCents) lines.push(`年费：${formatYuan(policy.annualFeeCents)}`);
  return lines.length ? lines.join('\n') : '这张卡还没设资料～';
}

export function feeDateForYear(account, year) {
  const policy = account.meta.credit_card;
  const daysInMonth = new Date(Date.UTC(year, policy.feeMonth, 0)).getUTCDate();
  const day = Math.min(policy.feeDay, daysInMonth);
  return `${year}-${pad2(policy.feeMonth)}-${pad2(day)}`;
}

export function nextFeeDate(account, asOf = todayInShanghai()) {
  const year = Number(asOf.slice(0, 4));
  const thisYear = feeDateForYear(account, year);
  return thisYear >= asOf ? thisYear : feeDateForYear(account, year + 1);
}

export function annualFeeWindow(account, feeDate) {
  const feeYear = Number(feeDate.slice(0, 4));
  const previous = feeDateForYear(account, feeYear - 1);
  return { start: addDays(previous, 1), end: feeDate };
}

function refundTotalCents(voucher) {
  return sumCents(
    (voucher.entries || [])
      .filter((entry) => entry.target === 'category' && entry.kind === 'income' && entry.side === 'credit')
      .map((entry) => entry.amountCents),
  );
}

function cardSpendCents(voucher, accountId) {
  return sumCents(
    (voucher.entries || [])
      .filter((entry) => entry.target === 'account' && entry.id === accountId && entry.side === 'credit')
      .map((entry) => entry.amountCents),
  );
}

/**
 * 年费进度：窗口内有效消费笔数、还差几笔、还有几天。
 * 全额退款的原消费不算；部分退款仍算 1 笔，但会标出来。
 */
export function cardProgress(store, account, asOf = todayInShanghai()) {
  const policy = account.meta && account.meta.credit_card;
  if (!policy) return null;
  if (!policy.feeMonth || !policy.feeDay || !policy.annualFeeCents) return null;

  const next = nextFeeDate(account, asOf);
  const window = annualFeeWindow(account, next);
  const year = Number(next.slice(0, 4));
  const waived = (policy.waivedYears || []).includes(year);
  const charged = (policy.chargedYears || []).includes(year);

  const vouchers = store.vouchers();
  const refundsByOriginal = new Map();
  for (const voucher of vouchers) {
    if (voucher.type !== 'refund' || !voucher.refundOf) continue;
    refundsByOriginal.set(
      voucher.refundOf,
      (refundsByOriginal.get(voucher.refundOf) || 0) + refundTotalCents(voucher),
    );
  }

  let counted = 0;
  let partialRefunds = 0;
  for (const voucher of vouchers) {
    if (voucher.type !== 'expense') continue;
    if (voucher.date < window.start || voucher.date > window.end) continue;
    const spendCents = cardSpendCents(voucher, account.id);
    if (spendCents <= 0) continue;

    const refunded = refundsByOriginal.get(voucher.id) || 0;
    if (refunded >= spendCents) continue;
    if (refunded > 0) partialRefunds += 1;
    counted += 1;
  }

  const required = policy.waiverCount || 0;
  const remaining = waived ? 0 : Math.max(0, required - counted);
  const daysLeft = daysBetween(asOf, next);

  let reminder = null;
  if (!waived && !charged && remaining > 0) {
    if (daysLeft <= 7) reminder = `还有 ${daysLeft} 天，还差 ${remaining} 笔，记得刷一下哦。`;
    else if (daysLeft <= 30) reminder = `还有 ${daysLeft} 天，还差 ${remaining} 笔。`;
  }

  return {
    accountId: account.id,
    accountName: account.name,
    nextFeeDate: next,
    windowStart: window.start,
    windowEnd: window.end,
    year,
    required,
    counted,
    remaining,
    daysLeft,
    waived,
    charged,
    partialRefunds,
    reminder,
    feeCents: policy.annualFeeCents,
  };
}

export function cardProgressText(progress) {
  if (!progress) return '';
  if (progress.waived) return `${progress.accountName}：${progress.year} 年费已免，这个周期不用管啦。`;
  if (progress.charged) return `${progress.accountName}：${progress.year} 年费已经记过账了。`;
  const lines = [
    `${progress.accountName} 年费进度：需刷 ${progress.required} 笔，本周期已刷 ${progress.counted} 笔，还差 ${progress.remaining} 笔。`,
    `窗口 ${progress.windowStart} → ${progress.windowEnd}，扣费日 ${progress.nextFeeDate}，还有 ${progress.daysLeft} 天。`,
  ];
  if (progress.partialRefunds) lines.push(`其中 ${progress.partialRefunds} 笔发生过部分退款，仍算 1 笔。`);
  if (progress.reminder) lines.push(progress.reminder);
  return lines.join('\n');
}

export function waiveAnnualFee(store, account, year) {
  const policy = account.meta && account.meta.credit_card;
  if (!policy) throw new Error('这张卡还没设年费政策');
  const targetYear = year ? Number(year) : Number(nextFeeDate(account).slice(0, 4));
  policy.waivedYears = [...new Set([...(policy.waivedYears || []), targetYear])].sort((a, b) => a - b);
  account.meta = { ...(account.meta || {}), credit_card: policy };
  store.saveAccounts();
  return { ok: true, year: targetYear };
}

export function chargeAnnualFee(store, account, options = {}) {
  const policy = account.meta && account.meta.credit_card;
  if (!policy) return { ok: false, errors: [{ code: 'NO_POLICY', message: '这张卡还没设年费政策' }] };

  const year = options.year ? Number(options.year) : Number(nextFeeDate(account).slice(0, 4));
  if ((policy.waivedYears || []).includes(year)) {
    return { ok: false, errors: [{ code: 'WAIVED', message: `${year} 年的年费已经标成免了` }] };
  }
  if ((policy.chargedYears || []).includes(year)) {
    return { ok: false, errors: [{ code: 'CHARGED', message: `${year} 年的年费已经记过了` }] };
  }

  const built = buildVoucher(store, {
    date: options.date || feeDateForYear(account, year),
    type: 'annual_fee',
    memo: `${account.name} ${year} 年费`,
    entries: [
      { target: 'category', id: 'exp_finance', side: 'debit', amount: formatYuan(policy.annualFeeCents) },
      { target: 'account', id: account.id, side: 'credit', amount: formatYuan(policy.annualFeeCents) },
    ],
  });
  if (!built.ok) return built;

  built.voucher.annualFeeYear = year;
  postVoucher(store, built.voucher);
  policy.chargedYears = [...new Set([...(policy.chargedYears || []), year])].sort((a, b) => a - b);
  account.meta = { ...(account.meta || {}), credit_card: policy };
  store.saveAccounts();
  return { ok: true, voucher: built.voucher, year };
}
