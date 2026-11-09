// 鲸鲸说的话。平时短，出问题才多说；一次最多一个表情。

import { formatYuan } from './money.js';

const TYPE_NAMES = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  repayment: '还款',
  refund: '退款',
  advance: '垫付',
  reimbursement: '报销',
  bad_debt: '坏账',
  installment: '分期',
  installment_payment: '分期还款',
  annual_fee: '年费',
  loan: '借出',
  loan_repayment: '还款',
  prepaid: '预付',
  amortization: '摊销',
  adjustment: '调整',
  opening: '期初',
  compensation: '补偿',
};

export function typeName(type) {
  return TYPE_NAMES[type] || type;
}

export function shortDate(date) {
  return String(date).slice(5).replace('-', '/');
}

function sideLabel(entry) {
  if (entry.target === 'account') return entry.side === 'debit' ? '账户·进' : '账户·出';
  return entry.kind === 'income' ? '收入' : '支出';
}

export function recordMessage(voucher, { balanceChanges = [], uninitialized = [] } = {}) {
  const lines = ['记好啦～🐋'];
  lines.push(`${shortDate(voucher.date)} · ${typeName(voucher.type)}`);
  if (voucher.memo) lines.push(voucher.memo);
  for (const entry of voucher.entries) {
    lines.push(`  ${entry.name} ${formatYuan(entry.amountCents)}（${sideLabel(entry)}）`);
  }
  if (voucher.details && voucher.details.length) {
    lines.push(`  明细 ${voucher.details.length} 行，合计 ${formatYuan(voucher.totals.detailNetCents)}`);
  }
  for (const warning of voucher.warnings || []) {
    lines.push(`  ⚠ ${warning}`);
  }
  if (balanceChanges.length) {
    lines.push(
      `  余额：${balanceChanges
        .map((change) => `${change.name} ${formatYuan(change.before)} → ${formatYuan(change.after)}`)
        .join('；')}`,
    );
  }
  if (uninitialized.length) {
    lines.push(`  （${uninitialized.join('、')} 还没告诉我余额，先按 0 算）`);
  }
  return lines.join('\n');
}

export function fixMessage(voucher, oldEntries = []) {
  const lines = ['改好啦～'];
  lines.push(`${shortDate(voucher.date)} · ${typeName(voucher.type)}`);
  for (const entry of voucher.entries) {
    lines.push(`  ${entry.name} ${formatYuan(entry.amountCents)}（${sideLabel(entry)}）`);
  }
  if (oldEntries.length) {
    const before = oldEntries
      .filter((entry) => entry.target === 'account')
      .map((entry) => entry.name)
      .join('、');
    if (before) lines.push(`  原来记的是：${before}`);
  }
  return lines.join('\n');
}

export function questionMessage(question) {
  if (question.reason === 'large_diff') {
    return [
      `这笔差得有点多（差了 ${formatYuan(Math.abs(question.diffCents))}），鲸鲸不敢自己拿主意。`,
      '是金额说错了，还是有一笔没提到呀？',
    ].join('\n');
  }
  if (question.reason === 'details_exceed') {
    return [
      question.message + '。',
      '是明细多写了，还是总价少说了呀？告诉鲸鲸，我改～',
    ].join('\n');
  }
  return question.message || '这笔鲸鲸拿不准，你说一句我再记。';
}

export function errorsMessage(errors) {
  return [
    '鲸鲸没记上：',
    ...errors.map((error) => `  · ${error.message}`),
  ].join('\n');
}

export function balanceMessage(report) {
  if (!report.rows.length) return '账本里还没有账户呢～先记一笔，或者告诉我你有哪几张卡。';

  const lines = [];
  lines.push(
    `你现在一共 ${formatYuan(report.netCents)} 元（资产 ${formatYuan(report.assetsCents)} − 欠款 ${formatYuan(report.debtsCents)}）。`,
  );
  for (const row of report.rows) {
    const note = row.excludeFromAssets
      ? '（不计资产）'
      : row.initialKnown || row.isInvestment
        ? ''
        : '（期初未告知）';
    lines.push(`  ${row.name} ${formatYuan(row.balanceCents)}${note}`);
  }
  if (report.uninitialized.length) {
    lines.push(`还有 ${report.uninitialized.length} 个账户没告诉我余额，先按 0 算了。`);
  }
  return lines.join('\n');
}

export function initBalanceMessage(accountName, targetCents, flowsCents, initialCents) {
  return [
    `收到～${accountName} 现在 ${formatYuan(targetCents)}。`,
    `往前一算：之前流水 ${formatYuan(flowsCents)}，所以期初应该是 ${formatYuan(initialCents)}。`,
    '已经记好啦，以后这个账户的数就准了。',
  ].join('\n');
}
