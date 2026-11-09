// prepaid 领域工具：待摊费用。

import { todayInShanghai } from '../core/ledger.js';
import { formatYuan } from '../core/money.js';
import { amortizeAllPrepaids, amortizePrepaid, createPrepaid, updatePrepaid } from '../core/plans.js';
import { errorsMessage, questionMessage } from '../core/wording.js';
import * as shared from './shared.js';

const { openStore, textOutput } = shared;

function scheduleText(plan) {
  const day = plan.amortizationDay || Number(String(plan.startDate).slice(8, 10));
  return `首期 ${plan.startDate}，之后每月 ${day} 号，共 ${plan.periods} 期`;
}

export const prepaidTools = [
  {
    name: 'whale_prepaid',
    description:
      '待摊费用：房租/学费/住宿费/物业费/取暖费等明确覆盖超过一个月的支出。默认首期在付款日、之后每月同日；到期自动摊销，幂等。用户没明确说周期就不要用，按普通支出记。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'amortize', 'update'] },
        name: { type: 'string', description: '待摊名称，如 房租、学费' },
        total: { type: 'string', description: '总金额' },
        account: { type: 'string', description: '付款账户' },
        category: { type: 'string', description: '摊销到的支出类别' },
        startDate: { type: 'string', description: '付款日/首期日，YYYY-MM-DD' },
        periods: { type: 'number', description: '期数；由用户说的期间推断，如一年 12、一学期 6、一季度 3' },
        amortizationDay: { type: 'number', description: '每月几号摊，默认付款日的几号' },
        planId: { type: 'string', description: '待摊计划 id' },
        through: { type: 'string', description: '摊销到哪天，默认今天' },
        memo: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      try {
        if (args.action === 'create') {
          if (!args.periods) {
            return { text: '要告诉我覆盖几个月/几期，我才能摊；没明确周期就按普通支出记。', error: true };
          }
          const created = createPrepaid(store, args);
          if (created.needsQuestion) return { text: questionMessage(created), needsQuestion: true };
          if (!created.ok) return { text: errorsMessage(created.errors), error: true };
          const auto = amortizePrepaid(store, created.plan.id, { through: todayInShanghai() });
          const posted = auto.ok ? auto.vouchers.length : 0;
          return {
            text: [
              `待摊记好啦～${created.plan.name}`,
              `  总额 ${formatYuan(created.plan.totalCents)} ｜ ${scheduleText(created.plan)}`,
              `  已摊 ${posted} 期，每期约 ${formatYuan(created.plan.perPeriodCents)}`,
              '  想改期数、日期、金额或类别，告诉我。',
            ].join('\n'),
            planId: created.plan.id,
          };
        }
        if (args.action === 'list') {
          const auto = amortizeAllPrepaids(store, args.through || todayInShanghai());
          if (!auto.ok) return { text: errorsMessage(auto.errors), error: true };
          const plans = store.plans.filter((plan) => plan.kind === 'prepaid');
          if (!plans.length) return { text: '还没有待摊计划～' };
          return {
            text: plans
              .map(
                (plan) =>
                  `${plan.name}（${plan.id}）｜ ${scheduleText(plan)} ｜ 已摊 ${(plan.amortizedPeriods || []).length}/${plan.periods} 期 ｜ ${plan.status}`,
              )
              .join('\n'),
          };
        }
        if (args.action === 'amortize') {
          const through = args.through || todayInShanghai();
          const result = args.planId
            ? amortizePrepaid(store, args.planId, { through })
            : amortizeAllPrepaids(store, through);
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          const vouchers = args.planId ? result.vouchers : result.results.flatMap((item) => item.vouchers);
          return { text: `摊销完成：新生成 ${vouchers.length} 期。` };
        }
        if (args.action === 'update') {
          const result = updatePrepaid(store, args.planId, args);
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: `待摊改好啦～${result.plan.name}\n  ${scheduleText(result.plan)}；剩余每期约 ${formatYuan(
              result.plan.perPeriodCents,
            )}`,
            planId: result.plan.id,
          };
        }
      } catch (error) {
        return { text: `鲸鲸出错了：${error.message}`, error: true };
      }
      return { text: `不认识待摊操作：${args.action}`, error: true };
    },
  },
];
