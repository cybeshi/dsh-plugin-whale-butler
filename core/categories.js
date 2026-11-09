// 类别（用户嘴里的“项目”）：支出和收入两棵树。
// 设计原则：一级稳定；二级只放没争议的；所有类目可改；迁移保留 id，历史单据自动跟随。

const c = (id, name, kind, parentId = null, aliases = [], extra = {}) => ({
  id,
  name,
  kind,
  parentId,
  aliases,
  system: true,
  ...extra,
});

export const DEFAULT_CATEGORIES = [
  // 支出：17 个一级
  c('exp_clothes', '服饰鞋帽', 'expense', null, ['衣物']),
  c('exp_food', '食品餐饮', 'expense', null, ['食品']),
  c('exp_housing', '住房', 'expense', null, ['居住']),
  c('exp_transport', '出行交通', 'expense', null, ['交通']),
  c('exp_education', '学习教育', 'expense', null, ['教育']),
  c('exp_fun', '娱乐休闲', 'expense', null, ['娱乐']),
  c('exp_trip', '旅行', 'expense'),
  c('exp_childcare', '抚养', 'expense'),
  c('exp_eldercare', '赡养', 'expense'),
  c('exp_support', '扶助', 'expense', null, ['捐赠']),
  c('exp_social', '社交', 'expense', null, ['人情']),
  c('exp_wedding', '红白喜事', 'expense', null, ['婚丧嫁娶']),
  c('exp_daily', '日用日常', 'expense', null, ['日用']),
  c('exp_medical', '医疗保健', 'expense', null, ['医疗']),
  c('exp_digital', '数码电子', 'expense', null, ['数码']),
  c('exp_repair', '维修维护', 'expense'),
  c('exp_other', '其他', 'expense', null, ['其他支出']),

  // 支出二级：只放不容易有争议的
  c('exp_clothes_top', '衣服', 'expense', 'exp_clothes'),
  c('exp_clothes_underwear', '内衣袜子', 'expense', 'exp_clothes'),
  c('exp_clothes_shoes', '鞋靴', 'expense', 'exp_clothes'),
  c('exp_clothes_accessory', '配饰', 'expense', 'exp_clothes'),
  c('exp_food_meat', '肉', 'expense', 'exp_food'),
  c('exp_food_egg', '蛋', 'expense', 'exp_food'),
  c('exp_food_milk', '奶', 'expense', 'exp_food'),
  c('exp_food_vegetable', '蔬菜', 'expense', 'exp_food'),
  c('exp_food_fruit', '水果', 'expense', 'exp_food'),
  c('exp_food_snack', '零食', 'expense', 'exp_food'),
  c('exp_food_alcohol', '酒水', 'expense', 'exp_food'),
  c('exp_food_drink', '饮料', 'expense', 'exp_food'),
  c('exp_food_eatout', '外卖餐馆', 'expense', 'exp_food'),
  c('exp_tobacco', '烟酒', 'expense', 'exp_food'),
  c('exp_housing_rent', '房租', 'expense', 'exp_housing'),
  c('exp_housing_property', '物业费', 'expense', 'exp_housing'),
  c('exp_housing_heating', '取暖费', 'expense', 'exp_housing'),
  c('exp_housing_electricity', '电费', 'expense', 'exp_housing'),
  c('exp_housing_water', '水费', 'expense', 'exp_housing'),
  c('exp_housing_gas', '燃气费', 'expense', 'exp_housing'),
  c('exp_housing_sanitation', '卫生费', 'expense', 'exp_housing'),
  c('exp_comms', '通讯网络', 'expense', 'exp_housing'),
  c('exp_transport_train', '火车票', 'expense', 'exp_transport'),
  c('exp_transport_flight', '机票', 'expense', 'exp_transport'),
  c('exp_transport_ship', '船票', 'expense', 'exp_transport'),
  c('exp_transport_taxi', '出租车网约车', 'expense', 'exp_transport'),
  c('exp_transport_metro', '地铁公交', 'expense', 'exp_transport'),
  c('exp_transport_bike', '共享单车', 'expense', 'exp_transport'),
  c('exp_transport_fuel', '油费', 'expense', 'exp_transport'),
  c('exp_transport_charge', '充电', 'expense', 'exp_transport'),
  c('exp_transport_parking', '停车费', 'expense', 'exp_transport'),
  c('exp_transport_toll', '过路费', 'expense', 'exp_transport'),
  c('exp_transport_fine', '交通违章罚款', 'expense', 'exp_transport'),
  c('exp_travel', '差旅', 'expense', 'exp_transport'),
  c('exp_education_stationery', '文具', 'expense', 'exp_education'),
  c('exp_education_books', '图书', 'expense', 'exp_education'),
  c('exp_education_training', '培训', 'expense', 'exp_education'),
  c('exp_education_tuition', '学费', 'expense', 'exp_education'),
  c('exp_education_materials', '学习资料', 'expense', 'exp_education'),
  c('exp_fun_toy', '玩具', 'expense', 'exp_fun'),
  c('exp_fun_model', '模型', 'expense', 'exp_fun'),
  c('exp_fun_instrument', '乐器', 'expense', 'exp_fun'),
  c('exp_fun_sauna', '桑拿按摩', 'expense', 'exp_fun'),
  c('exp_fun_beauty', '美容美发', 'expense', 'exp_fun'),
  c('exp_fun_movie', '电影演出', 'expense', 'exp_fun'),
  c('exp_fun_membership', '会员订阅', 'expense', 'exp_fun'),
  c('exp_trip_transport', '交通（旅）', 'expense', 'exp_trip'),
  c('exp_trip_food', '餐饮（旅）', 'expense', 'exp_trip'),
  c('exp_trip_lodging', '住宿（旅）', 'expense', 'exp_trip'),
  c('exp_trip_tickets', '门票（旅）', 'expense', 'exp_trip'),
  c('exp_childcare_tuition', '学费（抚）', 'expense', 'exp_childcare'),
  c('exp_childcare_food', '餐饮（抚）', 'expense', 'exp_childcare'),
  c('exp_childcare_lodging', '住宿费（抚）', 'expense', 'exp_childcare'),
  c('exp_childcare_stationery', '文具（抚）', 'expense', 'exp_childcare'),
  c('exp_childcare_sports', '体育（抚）', 'expense', 'exp_childcare'),
  c('exp_childcare_clothes', '衣物（抚）', 'expense', 'exp_childcare'),
  c('exp_childcare_medical', '医疗（抚）', 'expense', 'exp_childcare'),
  c('exp_eldercare_living', '生活费（赡）', 'expense', 'exp_eldercare'),
  c('exp_eldercare_medical', '医疗（赡）', 'expense', 'exp_eldercare'),
  c('exp_support_gift', '亲友赠与', 'expense', 'exp_support'),
  c('exp_support_redpacket', '红包（扶）', 'expense', 'exp_support'),
  c('exp_support_charity', '公益捐赠', 'expense', 'exp_support'),
  c('exp_social_treat', '请客', 'expense', 'exp_social'),
  c('exp_social_gift', '礼物', 'expense', 'exp_social'),
  c('exp_social_redpacket', '红包（社）', 'expense', 'exp_social'),
  c('exp_wedding_wedding', '婚礼', 'expense', 'exp_wedding'),
  c('exp_wedding_funeral', '丧事', 'expense', 'exp_wedding'),
  c('exp_wedding_banquet', '寿宴满月', 'expense', 'exp_wedding'),
  c('exp_wedding_cashgift', '礼金', 'expense', 'exp_wedding'),
  c('exp_wedding_feast', '宴席', 'expense', 'exp_wedding'),
  c('exp_wedding_service', '婚庆丧葬', 'expense', 'exp_wedding'),
  c('exp_wedding_other', '其他（红白）', 'expense', 'exp_wedding'),
  c('exp_daily_goods', '日用品', 'expense', 'exp_daily'),
  c('exp_daily_women', '妇女用品', 'expense', 'exp_daily'),
  c('exp_daily_skincare', '护肤品', 'expense', 'exp_daily'),
  c('exp_daily_cleaning', '清洁用品', 'expense', 'exp_daily'),
  c('exp_daily_paper', '纸品', 'expense', 'exp_daily'),
  c('exp_medical_clinic', '门诊', 'expense', 'exp_medical'),
  c('exp_medical_hospital', '住院', 'expense', 'exp_medical'),
  c('exp_medical_medicine', '药品', 'expense', 'exp_medical'),
  c('exp_medical_checkup', '体检', 'expense', 'exp_medical'),
  c('exp_digital_phone', '手机', 'expense', 'exp_digital'),
  c('exp_digital_computer', '电脑', 'expense', 'exp_digital'),
  c('exp_digital_accessory', '数码配件', 'expense', 'exp_digital'),
  c('exp_digital_software', '软件会员', 'expense', 'exp_digital'),
  c('exp_repair_appliance', '家电维修', 'expense', 'exp_repair'),
  c('exp_repair_house', '房屋维修', 'expense', 'exp_repair'),
  c('exp_repair_tools', '工具', 'expense', 'exp_repair'),
  c('exp_other_tax', '税费', 'expense', 'exp_other'),
  c('exp_other_express', '快递', 'expense', 'exp_other'),

  // 系统内部支出：不放进用户选择
  c('exp_finance', '金融费用', 'expense', null, [], { hidden: true }),
  c('exp_interest', '利息费用', 'expense', null, [], { hidden: true }),
  c('exp_baddebt', '坏账损失', 'expense', null, ['坏账'], { hidden: true }),
  c('exp_reconcile_loss', '对账损失', 'expense', null, [], { hidden: true }),
  c('exp_sales_cost', '销售成本', 'expense', null, [], { hidden: true }),
  c('exp_sales_return', '销售退回', 'expense', null, [], { hidden: true }),
  c('exp_return_loss', '退货损失', 'expense', null, [], { hidden: true }),
  c('exp_other_diff', '差额支出', 'expense', 'exp_other', [], { hidden: true }),
  c('exp_other_loss', '意外损失', 'expense', 'exp_other', [], { hidden: true }),
  c('exp_other_invest_adjust', '投资收益调整(减)', 'expense', 'exp_other', [], {
    hidden: true,
    excludeFromReport: true,
  }),

  // 收入：8 个一级
  c('inc_salary', '工资薪酬', 'income', null, ['工资']),
  c('inc_business', '经营收入', 'income'),
  c('inc_other_invest', '投资收益', 'income', null, ['投资收益']),
  c('inc_other_interest', '利息收入', 'income', null, ['利息收入']),
  c('inc_redgift', '红包礼金', 'income'),
  c('inc_other_refund', '退款', 'income', null, ['退款']),
  c('inc_comp', '补偿赔偿', 'income'),
  c('inc_other', '其他收入', 'income'),

  // 收入二级
  c('inc_sales_revenue', '销售收入', 'income', 'inc_business'),
  c('inc_daigou', '代购收入', 'income', 'inc_business'),
  c('inc_service', '服务收入', 'income', 'inc_business'),
  c('inc_redgift_redpacket', '红包', 'income', 'inc_redgift'),
  c('inc_redgift_gift', '礼金', 'income', 'inc_redgift'),
  c('inc_other_comp', '补偿', 'income', 'inc_comp'),
  c('inc_comp_pay', '赔偿', 'income', 'inc_comp'),
  c('inc_other_redpacket', '平台红包', 'income', 'inc_other', ['返现']),
  c('inc_other_windfall', '意外收入', 'income', 'inc_other'),

  // 系统内部收入：不放进用户选择
  c('inc_sales_cost_reversal', '销售成本冲回', 'income', 'inc_business', [], { hidden: true }),
  c('inc_return_gain', '退货收益', 'income', 'inc_business', [], { hidden: true }),
  c('inc_other_diff', '差额收入', 'income', 'inc_other', [], { hidden: true }),
  c('inc_other_invest_adjust', '投资收益调整(增)', 'income', 'inc_other', [], {
    hidden: true,
    excludeFromReport: true,
  }),
  c('inc_reconcile_gain', '对账收益', 'income', 'inc_other', [], { hidden: true }),
];

export function seedCategories() {
  return DEFAULT_CATEGORIES.map((category) => ({ ...category, aliases: [...(category.aliases || [])] }));
}

export function ensureSeedCategories(categories) {
  const added = [];
  for (const seed of DEFAULT_CATEGORIES) {
    const exists = categories.some(
      (category) =>
        category.id === seed.id ||
        (category.name === seed.name && category.kind === seed.kind && category.parentId === seed.parentId),
    );
    if (!exists) {
      categories.push({ ...seed, aliases: [...(seed.aliases || [])] });
      added.push(seed);
    }
  }
  return added;
}

const LEGACY_PARENT = {
  工具: ['exp_repair', '工具'],
  捐赠: ['exp_support', '公益捐赠'],
  公益捐赠: ['exp_support', '公益捐赠'],
  数码: ['exp_digital', '数码配件'],
  数码配件: ['exp_digital', '数码配件'],
  推广: ['inc_business', '推广'],
  人情: ['exp_social', '人情往来'],
};

/** 老账本迁移：只改类目定义，保留 id；历史单据按 id 自动跟随。 */
export function migrateCategoryTaxonomy(categories) {
  let changed = false;
  const byId = new Map(categories.map((category) => [category.id, category]));
  const oldNameById = new Map(categories.map((category) => [category.id, category.name]));
  const idAlias = new Map();

  // 先补齐一级，旧自定义类目才有上级可挂。
  for (const spec of DEFAULT_CATEGORIES.filter((category) => !category.parentId)) {
    if (byId.has(spec.id)) continue;
    const duplicate = categories.find(
      (category) => category.name === spec.name && category.kind === spec.kind && category.parentId === null,
    );
    if (duplicate) {
      // 同名一级已存在：复用它，后面的二级挂到它下面，不再建孤儿。
      idAlias.set(spec.id, duplicate.id);
      const aliases = new Set([...(duplicate.aliases || []), ...(spec.aliases || [])]);
      const nextAliases = [...aliases];
      if (JSON.stringify(nextAliases) !== JSON.stringify(duplicate.aliases || [])) {
        duplicate.aliases = nextAliases;
        changed = true;
      }
      continue;
    }
    const created = { ...spec, aliases: [...(spec.aliases || [])] };
    categories.push(created);
    byId.set(created.id, created);
    changed = true;
  }

  // 再把旧的自定义类目归位，最后补二级，避免同名重复。
  for (const category of categories) {
    const legacy = LEGACY_PARENT[category.name];
    if (legacy) {
      const [parentId, name] = legacy;
      const parent = byId.get(parentId) || categories.find((candidate) => candidate.id === parentId);
      if (parent) {
        category.parentId = parentId;
        category.name = name;
        changed = true;
      }
    }
  }

  for (const spec of DEFAULT_CATEGORIES) {
    const parentId = spec.parentId ? idAlias.get(spec.parentId) || spec.parentId : null;
    const current = byId.get(spec.id);
    if (!current) {
      const duplicate = categories.find(
        (category) => category.name === spec.name && category.kind === spec.kind && category.parentId === parentId,
      );
      if (!duplicate) {
        categories.push({ ...spec, parentId, aliases: [...(spec.aliases || [])] });
        changed = true;
      }
      continue;
    }
    const oldName = oldNameById.get(spec.id);
    const aliases = new Set([...(current.aliases || []), ...(spec.aliases || [])]);
    if (oldName && oldName !== spec.name && !(spec.id === 'inc_other_redpacket' && oldName === '红包')) {
      aliases.add(oldName);
    }
    const next = {
      ...current,
      ...spec,
      parentId,
      aliases: [...aliases],
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      Object.assign(current, next);
      changed = true;
    }
  }

  return changed;
}

export function categoryById(categories, id) {
  return categories.find((category) => category.id === id) || null;
}

/**
 * 按 id、名字、别名、或“其他收入/红包”这样的路径找类别。
 * 同名有多个时直接问清楚，不瞎猜。
 */
export function findCategory(categories, key) {
  if (key === null || key === undefined || key === '') return null;

  const byId = categories.find((category) => category.id === key);
  if (byId) return byId;

  const parts = String(key).split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    let parent = null;
    for (const part of parts) {
      const hit = categories.find(
        (category) =>
          (category.name === part || (category.aliases || []).includes(part)) &&
          (parent ? category.parentId === parent.id : true),
      );
      if (!hit) return null;
      parent = hit;
    }
    return parent;
  }

  const matches = categories.filter(
    (category) => category.name === key || (category.aliases || []).includes(key),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`类别「${key}」有好几个，鲸鲸分不清：${matches.map((m) => m.id).join('、')}`);
  }
  return null;
}

export function categoryPath(categories, id) {
  const chain = [];
  let current = categoryById(categories, id);
  while (current) {
    chain.unshift(current.name);
    current = current.parentId ? categoryById(categories, current.parentId) : null;
  }
  return chain.join('/');
}
