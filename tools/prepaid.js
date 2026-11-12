// prepaid 领域工具：待摊费用。

import { todayInShanghai } from '../core/ledger.js';
import { formatYuan } from '../core/money.js';
import { amortizeAllPrepaids, amortizePrepaid, createPrepaid, previewPrepaidSchedule, updatePrepaid } from '../core/plans.js';
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
      '待摊费用：凡是这笔钱覆盖一段跨月时期的预付支出，都用这个工具，不要记成一次性支出。用户明确说覆盖期/期数时按用户的；覆盖期按自然月或一个月周期摊，期数等额按期数平分。金额按实际覆盖天数或按期数等分；到期自动摊销，幂等。不要替用户编造未见过的具体日期。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'detail', 'amortize', 'update'] },
        name: { type: 'string', description: '待摊名称' },
        total: { type: 'string', description: '总金额' },
        account: { type: 'string', description: '付款账户' },
        category: { type: 'string', description: '摊销到的支出类别' },
        paidAt: { type: 'string', description: '实际付款日期 YYYY-MM-DD；与首期开始日可不同' },
        coverageStart: { type: 'string', description: '覆盖期开始 YYYY-MM-DD（这笔钱买的服务从哪天开始）' },
        coverageEnd: { type: 'string', description: '覆盖期结束 YYYY-MM-DD（含当天）' },
        mode: {
          type: 'string',
          enum: ['even', 'calendar', 'cycle'],
          description:
            '分摊口径：even 按期数等额；calendar 按自然月、金额按覆盖天数；cycle 按一个月周期。用户说了固定期数用 even，覆盖期按自然月用 calendar，按月周期用 cycle。',
        },
        startDate: { type: 'string', description: '首期开始日 YYYY-MM-DD（不是付款日；付款日看 paidAt）' },
        periods: { type: 'number', description: '期数；even 必填，calendar/cycle 由日期算' },
        amortizationDay: { type: 'number', description: '每月几号摊销；仅 even 模式用，默认首期日的几号' },
        planId: { type: 'string', description: '待摊计划 id' },
        through: { type: 'string', description: '摊销到哪天，默认今天' },
        overrides: {
          type: 'object',
          description: '按期的修改：{"3":{"date":"YYYY-MM-DD","amount":"1400"}}',
        },
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
              text: '这笔覆盖到哪天？告诉我起止日期，或者覆盖几个月。',
              needsQuestion: true,
            };
          }
          if (hasCoverage && args.mode === 'even' && !args.periods) {
            return {
              text: '按固定期数等额摊，要告诉我一共分几期。',
              needsQuestion: true,
            };
          }
          const created = createPrepaid(store, args);
          if (created.needsQuestion) return { text: questionMessage(created), needsQuestion: true };
          if (!created.ok) return { text: errorsMessage(created.errors), error: true };
          const auto = amortizePrepaid(store, created.plan.id, { through: todayInShanghai() });
          const posted = auto.ok ? auto.vouchers.length : 0;
          const detail = previewPrepaidSchedule(created.plan).map(
            (item) =>
              `  ${item.date} ｜ ${formatYuan(item.amountCents)}${item.days ? `（${item.days} 天）` : ''}`,
          );
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
        if (args.action === 'detail') {
          const plan = store.plans.find((candidate) => candidate.id === args.planId && candidate.kind === 'prepaid');
          if (!plan) return { text: `找不到待摊 ${args.planId}`, error: true };
          const rows = previewPrepaidSchedule(plan);
          const posted = new Set(plan.amortizedPeriods || []);
          const paidAmount = Object.values(plan.amortizedAmounts || {}).reduce((sum, amount) => sum + (amount || 0), 0);
          const modeText = plan.mode === 'even' ? '按期数等额' : plan.mode === 'cycle' ? '按月周期' : '按自然月';
          const lines = [
            `${plan.name}（${plan.id}）· ${plan.status}`,
            `  付款：${plan.paidAt} ｜ 总额 ${formatYuan(plan.totalCents)} ｜ 已摊 ${formatYuan(paidAmount)} ｜ 剩余 ${formatYuan(plan.totalCents - paidAmount)}`,
            `  口径：${modeText} ｜ 期数 ${plan.periods} ｜ 首期开始日 ${plan.startDate}`,
          ];
          if (plan.coverageStart || plan.coverageEnd) {
            lines.push(`  覆盖期：${plan.coverageStart || '—'} ~ ${plan.coverageEnd || '—'}`);
          } else {
            lines.push(`  每月摊销日：${plan.amortizationDay || '—'}`);
          }
          lines.push(`  单期修改：${Object.keys(plan.overrides || {}).length} 条`);
          lines.push('  排期：');
          for (const row of rows) {
            const override = (plan.overrides || {})[row.period];
            const status = posted.has(row.period) ? '已摊' : '待摊';
            lines.push(
              `    第 ${row.period} 期 ${row.date} ${formatYuan(row.amountCents)}${row.days ? `（${row.days} 天）` : ''} · ${status}${
                override ? ' · 有单期修改' : ''
              }`,
            );
          }
          return { text: lines.join('\n'), planId: plan.id };
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
          const detail = previewPrepaidSchedule(result.plan).map(
            (item) =>
              `  ${item.date} ｜ ${formatYuan(item.amountCents)}${item.days ? `（${item.days} 天）` : ''}`,
          );
          const cleared =
            result.clearedOverrides > 0
              ? [`  已清空 ${result.clearedOverrides} 条旧单期修改（覆盖期变了，旧排期不再适用）`]
              : [];
          return {
            text: [`待摊改好啦～${result.plan.name}`, `  ${scheduleText(result.plan)}`, ...detail, ...cleared].join('\n'),
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
