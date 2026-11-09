// debt 领域工具：债务（我欠别人）。

import { formatYuan } from '../core/money.js';
import { balancesByAccount } from '../core/accounts.js';
import { errorsMessage, questionMessage } from '../core/wording.js';
import {
  addDebtInterestRule,
  accrueDebtInterest,
  createDebt,
  debtInterestOutstandingCents,
  debtOutstandingPrincipal,
  debtPreviewCents,
  repayDebt,
} from '../core/debt.js';
import * as shared from './shared.js';

const { openStore, textOutput, describeVoucher } = shared;

export const debtTools = [
  {
    name: 'whale_debt',
    description:
      '债务/我欠别人的钱：期初欠款、借入、利息、还款。底层和债权共用往来账户；默认无还款计划、无利息，用户提了才加。还款先冲利息后本金，不复利。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'opening', 'list', 'rules', 'preview', 'accrue', 'repay'] },
        creditor: { type: 'string', description: '债主/我欠谁' },
        principal: { type: 'string', description: '欠款本金' },
        account: { type: 'string', description: '借入到账账户/还款账户' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        debtId: { type: 'string', description: '债务号' },
        amount: { type: 'string', description: '还款金额；accrue 时可手动指定利息' },
        from: { type: 'string', description: '计息开始日期' },
        to: { type: 'string', description: '计息结束日期' },
        ratePercent: { type: 'string', description: '年利率百分数，如 2.9' },
        memo: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      try {
        if (args.action === 'opening' || args.action === 'add') {
          if (!args.creditor) return { text: '要告诉我欠谁的', error: true };
          const result = createDebt(store, { ...args, opening: args.action === 'opening' });
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          if (result.opening) {
            return {
              text: [
                `期初债务记好啦～欠${args.creditor} ${formatYuan(result.debt.principalCents)}`,
                `  往来-${args.creditor} 现在是 -${formatYuan(result.debt.principalCents)}，计入负债。`,
                '  想加利息或还款，告诉我。',
              ].join('\n'),
              debtId: result.debt.id,
            };
          }
          return {
            text: [
              `债务记好啦～欠${args.creditor} ${formatYuan(result.debt.principalCents)}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            debtId: result.debt.id,
            voucherId: result.voucher.id,
          };
        }
        if (args.action === 'list') {
          if (!store.debts.length) return { text: '还没有债务～' };
          return {
            text: store.debts
              .map(
                (debt) =>
                  `${debt.id} ｜ ${debt.creditorName} ｜ 本金 ${formatYuan(debt.principalCents)} ｜ 剩 ${formatYuan(
                    debtOutstandingPrincipal(debt),
                  )} ｜ 未付利息 ${formatYuan(debtInterestOutstandingCents(debt))} ｜ ${debt.status}${
                    debt.opening ? ' ｜ 期初' : ''
                  }`,
              )
              .join('\n'),
          };
        }
        const debt = store.debts.find((candidate) => candidate.id === args.debtId);
        if (!debt) return { text: `找不到债务 ${args.debtId}`, error: true };
        if (args.action === 'preview') {
          const from = args.from || debt.startDate;
          const to = args.to || args.date || new Date().toISOString().slice(0, 10);
          return {
            text: `${debt.creditorName} 的利息预览：${from} 至 ${to} = ${formatYuan(
              debtPreviewCents(debt, from, to),
            )}（确认后才入账）`,
          };
        }
        if (args.action === 'rules') {
          const result = addDebtInterestRule(store, args.debtId, args);
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: `利率规则记好啦～${result.rule.from}${result.rule.to ? ` 至 ${result.rule.to}` : ' 起'} ${(
              result.rule.annualRateBps / 100
            ).toFixed(2)}%`,
          };
        }
        if (args.action === 'accrue') {
          const result = accrueDebtInterest(store, args.debtId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `债务利息计提好啦～${debt.creditorName}`,
              `  ${result.accrual.from} 至 ${result.accrual.to} ｜ ${formatYuan(result.accrual.amountCents)}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            debtId: debt.id,
            voucherId: result.voucher.id,
          };
        }
        if (args.action === 'repay') {
          const result = repayDebt(store, args.debtId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `还款记好啦～${debt.creditorName}`,
              `  本金 ${formatYuan(result.principalPart)} ｜ 利息 ${formatYuan(result.interestPart)}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            debtId: debt.id,
            voucherId: result.voucher.id,
          };
        }
      } catch (error) {
        return { text: `鲸鲸出错了：${error.message}`, error: true };
      }
      return { text: `不认识债务操作：${args.action}`, error: true };
    },
  },
];
