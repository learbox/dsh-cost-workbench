/**
 * prompts.json：prompt 模板库。
 *
 * 约定：{"prompts": {"<id>": {"title": "...", "text": "..."}}}
 * 卡片（kind=prompt 或带 promptId 的卡片）按 id 取模板；坏一条只丢那一条。
 */
import { readFile } from 'node:fs/promises'

/** 内置模板：prompts.json 缺失/损坏时的回退（与首次运行写出的种子一致）。 */
export const BUILTIN_PROMPTS = {
  'tender-review': {
    title: '招标文件审查',
    text: '请逐条审查这份招标文件的计价与合同条款，按「风险高 / 需澄清 / 可接受」三档输出。\n项目：\n招标人：\n重点：计价方式、暂列金额与暂估价、材料调差、工期与延误、变更签证、结算与支付节点、不平衡报价风险\n\n每条给出：条款位置 → 风险点 → 建议措辞（可直接放进澄清函）。缺口用【】标出。',
  },
  'bid-plan': {
    title: '投标文件框架',
    text: '帮我搭建投标文件框架。\n项目与标段：\n招标要求（评分办法要点）：\n我方优势与类似业绩：\n\n输出：商务标 / 技术标 / 资信标 的目录、每节要点、需要提供的证明材料清单，以及标书编制时间倒排（到天）。',
  },
  'variation-order': {
    title: '变更签证单',
    text: '起草一份工程变更签证单。\n项目：\n变更编号：\n变更事由：\n变更内容与工程量：\n计价依据（定额/信息价/市场询价）：\n影响工期：\n\n输出：签证单正文（事由、依据、工程量、单价、金额、工期影响），并列出需要附的支撑材料（图纸、联系单、影像、询价单）。金额一律给出计算过程。',
  },
  'claim-report': {
    title: '索赔与工期分析',
    text: '分析这项索赔是否成立、能主张多少。\n合同依据条款：\n事件经过与时间线：\n我方损失与工期影响：\n对方抗辩可能：\n\n输出：索赔成立性分析、可主张费用与工期、证据清单、谈判要点；对不利事实如实标注，不要编造依据。',
  },
  'inquiry-letter': {
    title: '询价 / 澄清函',
    text: '起草一份对外函件。\n类型：询价 / 澄清 / 催办 / 答复\n对象：\n事项与背景：\n希望对方回复的内容与期限：\n\n语言：简洁、可直接发出；金额与日期留出【】占位；不要写落款人名。',
  },
  'settlement-review': {
    title: '结算审核要点',
    text: '按结算审核口径列出这份结算的审核要点。\n合同类型（固定总价/可调/成本加酬金）：\n结算送审金额：\n工程内容与变更情况：\n\n输出：① 工程量核对重点 ② 单价与取费核对重点 ③ 变更签证与索赔的合规性 ④ 常见虚高项清单 ⑤ 需要补充的资料。每项都写「查什么、怎么查」。',
  },
  'boq-pricing': {
    title: '清单组价说明',
    text: '为下面这条清单项写组价说明（可直接附在报价单后面）。\n项目编码与名称：\n项目特征：\n计量单位与工程量：\n人工/材料/机械消耗：\n管理费与利润费率：\n\n输出：组价表（人工、材料、机械、管理费、利润、综合单价）、取费基数说明、以及可能被质疑的点与应答。',
  },
  'glossary-all': {
    title: '整表插入',
    text: '以下是本项目的造价术语表，本轮翻译与表述严格沿用这些译法，不要自行改词：\n\n',
  },
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function readPrompts(promptsFile) {
  let text
  try {
    text = await readFile(promptsFile, 'utf8')
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') {
      return { prompts: BUILTIN_PROMPTS, source: 'builtin' }
    }
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 读取失败，已用内置模板：' + describe(error) }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 不是合法 JSON，已用内置模板' }
  }
  const raw = parsed !== null && typeof parsed === 'object' && parsed.prompts !== null && typeof parsed.prompts === 'object' ? parsed.prompts : null
  if (raw === null) {
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 缺少 prompts 对象，已用内置模板' }
  }
  const prompts = {}
  for (const key of Object.keys(raw)) {
    const item = raw[key]
    if (item === null || typeof item !== 'object') continue
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    prompts[key] = {
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : key,
      text: item.text,
    }
  }
  if (Object.keys(prompts).length === 0) {
    return { prompts: BUILTIN_PROMPTS, source: 'builtin', warning: 'prompts.json 里没有一条可用模板，已用内置模板' }
  }
  return { prompts, source: 'file' }
}
