// 投资账户：市值、成本、浮盈、已实现收益、校准。

import { parseAmountToCents, sumCents } from './money.js';
import { balancesByAccount, investmentValueCents } from './accounts.js';
import { monthlyReport } from './report.js';
import { todayInShanghai } from './ledger.js';

export function investmentAccounts(store) {
  return store.accounts.filter((account) => (account.tags || []).includes('investment'));
}

export function investmentRows(store) {
  const balances = balancesByAccount(store.accounts, store.vouchers());
  return investmentAccounts(store).map((account) => {
    const investment = (account.meta && account.meta.investment) || {};
    const valueCents = balances.get(account.id) || 0;
    const costCents = investment.costCents || 0;
    return {
      account,
      valueCents,
      costCents,
      floatingCents: valueCents - costCents,
      sharesScaled: investment.sharesScaled ?? null,
      navScaled: investment.navScaled ?? null,
      manualValue: Number.isSafeInteger(investment.valueCents),
    };
  });
}

/**
 * 收益汇总：已实现（投资收益科目）单独列；浮盈只做资产信息；校准差额进调整，不算当期收入。
 */
export function investSummary(store, month) {
  const targetMonth = month || todayInShanghai().slice(0, 7);
  const rows = investmentRows(store);
  const report = monthlyReport(store, targetMonth);

  const realizedCents = sumCents(
    report.incomeRows.filter(([name]) => name === '投资收益').map(([, cents]) => cents),
  );

  let adjustmentsCents = 0;
  const adjustmentRows = [];
  for (const row of rows) {
    const investment = (row.account.meta && row.account.meta.investment) || {};
    for (const adjustment of investment.adjustments || []) {
      if (String(adjustment.date).slice(0, 7) !== targetMonth) continue;
      adjustmentsCents += adjustment.diffCents || 0;
      adjustmentRows.push({ accountName: row.account.name, ...adjustment });
    }
  }

  const totalValueCents = sumCents(rows.map((row) => row.valueCents));
  const totalCostCents = sumCents(rows.map((row) => row.costCents));

  return {
    month: targetMonth,
    rows,
    realizedCents,
    adjustmentsCents,
    adjustmentRows,
    totalValueCents,
    totalCostCents,
    floatingCents: totalValueCents - totalCostCents,
  };
}

export function calibrateInvestment(store, account, options = {}) {
  const investment = account.meta && account.meta.investment;
  if (!investment) throw new Error('这不是投资账户，先用 wb account invest 设份额和净值');

  const beforeCents = investmentValueCents(account);
  const targetCents = parseAmountToCents(options.value);
  const diffCents = targetCents - beforeCents;
  const date = options.date || todayInShanghai();

  investment.valueCents = targetCents;
  investment.adjustments = [
    ...(investment.adjustments || []),
    { date, diffCents, beforeCents, afterCents: targetCents, note: options.memo || '' },
  ];
  account.meta = { ...(account.meta || {}), investment };
  store.saveAccounts();
  store.audit({
    action: 'invest-calibrate',
    accountId: account.id,
    beforeCents,
    targetCents,
    diffCents,
    at: new Date().toISOString(),
  });

  return { ok: true, account, beforeCents, targetCents, diffCents };
}
