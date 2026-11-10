// prepaid 领域工具：待摊费用。

import { todayInShanghai } from '../core/ledger.js';
import { formatYuan } from '../core/money.js';
import { amortizeAllPrepaids, amortizePrepaid, createPrepaid, updatePrepaid } from '../core/plans.js';
import { errorsMessage, questionMessage } from '../core/wording.js';
import * as shared from './shared.js';

const { openStore, textOutput } = shared;

function scheduleText(plan) {
  if (Array.isArray(plan.schedule) && plan.schedule.length) {
    const mode = plan.mode === 'cycle' ? '按周期' : '按自然月';
    return `${mode}共 ${plan.periods} 期（覆盖 ${plan.coverageStart} ~ ${plan.coverageEnd}）`;
  }
  const day = plan.amortizationDay || Number(String(plan.startDate).slice(8, 10));
  return `首期 ${plan.startDate}，之后每月 ${day} 号，共 ${plan.periods} 期`;
}

export const prepaidTools = [
  {
    name: 'whale_prepaid',
    description:
      '待摊费用：房租、取暖费、学费、住宿费、物业费、保险费、年付宽带等——凡是这笔钱覆盖一段跨月时期的支出，都用这个工具，不要记成一次性支出。给了 coverageStart/coverageEnd 就按覆盖期摊：默认按自然月、金额按实际覆盖天数（11/15–3/14 会切成 11、12、1、2、3 五期且金额不等）；房租这类按月周期付款的用 mode=cycle。只给 periods 就给定期数等分。默认首期在付款日、到期自动摊销、幂等。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'amortize', 'update'] },
        name: { type: 'string', description: '待摊名称，如 房租、取暖费、学费' },
        total: { type: 'string', description: '总金额' },
        account: { type: 'string', description: '付款账户' },
        category: { type: 'string', description: '摊销到的支出类别' },
        paidAt: { type: 'string', description: '付款日期 YYYY-MM-DD，默认今天；可与覆盖期不同（比如 10 月交取暖费、11/15 才开始供暖）' },
        coverageStart: { type: 'string', description: '覆盖期开始 YYYY-MM-DD（这笔钱从哪天开始买服务）' },
        coverageEnd: { type: 'string', description: '覆盖期结束 YYYY-MM-DD（含当天）' },
        mode: {
          type: 'string',
          enum: ['calendar', 'cycle'],
          description:
            '分摊口径：calendar 按自然月、金额按覆盖天数不等（供暖、学费、年费，默认）；cycle 按每月同日为一期、金额相等（房租）',
        },
        startDate: { type: 'string', description: '不按覆盖期时用：首期 / 付款日 YYYY-MM-DD' },
        periods: { type: 'number', description: '期数；只有不给覆盖期时才需要（一年 12、一学期 6、一季度 3）' },
        amortizationDay: { type: 'number', description: '每月几号摊，默认付款日的几号（仅不按覆盖期时用）' },
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
          const hasCoverage = Boolean(args.coverageStart && args.coverageEnd);
          if (!hasCoverage && !args.periods) {
            return {
              text: '这笔覆盖到哪天？告诉我起止日期（比如 11/15 到 3/14），或者覆盖几个月。',
              needsQuestion: true,
            };
          }
          const created = createPrepaid(store, args);
          if (created.needsQuestion) return { text: questionMessage(created), needsQuestion: true };
          if (!created.ok) return { text: errorsMessage(created.errors), error: true };
          const auto = amortizePrepaid(store, created.plan.id, { through: todayInShanghai() });
          const posted = auto.ok ? auto.vouchers.length : 0;
          const detail = Array.isArray(created.plan.schedule)
            ? created.plan.schedule.map(
                (item) =>
                  `  ${item.date} ｜ ${formatYuan(item.amountCents)}${item.days ? `（${item.days} 天）` : ''}`,
              )
            : [`  每期约 ${formatYuan(created.plan.perPeriodCents)}`];
          return {
            text: [
              `待摊记好啦～${created.plan.name}`,
              `  总额 ${formatYuan(created.plan.totalCents)} ｜ ${scheduleText(created.plan)}`,
              ...detail,
              `  已摊 ${posted} 期，付款记在 ${created.plan.paidAt}`,
              '  想改哪一期、日期或类别，告诉我。',
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
            text: Array.isArray(result.plan.schedule)
              ? `待摊改好啦～${result.plan.name}\n  ${scheduleText(result.plan)}；各期金额按覆盖天数算。`
              : `待摊改好啦～${result.plan.name}\n  ${scheduleText(result.plan)}；剩余每期约 ${formatYuan(
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
