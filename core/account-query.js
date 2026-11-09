// 账户流水查询：给「看看这个账户最近几笔」用，避免模型去读 vouchers 文件。

export function accountTransactions(store, account, limit = 5) {
  const rows = [];
  for (const voucher of store.vouchers()) {
    for (const entry of voucher.entries || []) {
      if (entry.target !== 'account' || entry.id !== account.id) continue;
      rows.push({
        date: voucher.date,
        memo: voucher.memo || '',
        voucherId: voucher.id,
        side: entry.side,
        amountCents: entry.amountCents,
        type: voucher.type,
        createdAt: voucher.createdAt,
      });
    }
  }
  rows.sort(
    (a, b) =>
      String(b.date).localeCompare(String(a.date)) ||
      String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  return rows.slice(0, limit);
}
