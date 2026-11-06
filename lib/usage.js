/**
 * 用量角标：DeepSeek 余额 + 火山语音资源包剩余。
 *
 * - DeepSeek：官方 `GET https://api.deepseek.com/user/balance`，Bearer 鉴权。
 *   密钥按「环境变量 → DSH 凭据文件 → asr.json」顺序找，任何一步找到就用。
 * - 火山：`ResourcePacksStatus`（speech_saas_prod，2025-05-20）走火山 SigV4 签名，
 *   需要 **AK/SK**（控制台 → 访问控制 → 密钥），不是语音的 X-Api-Key。
 *   没配 AK/SK 时返回 configured:false，界面不显示这个角标。
 *
 * 两个结果都在 Host 侧缓存 5 分钟，界面刷新不会反复打接口。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_MS = 5 * 60 * 1000

/** 从 DSH 的凭据文件里捞 DEEPSEEK_API_KEY（只认 refs 段里的明文 sk- 值）。 */
async function readDeepseekKeyFromDsh() {
  try {
    const text = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const refs = text.split(/^refs:\s*$/m)[1] ?? ''
    for (const line of refs.split('\n')) {
      if (!line.includes('DEEPSEEK_API_KEY')) continue
      const value = line.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '')
      if (value.startsWith('sk-')) return value
      if (value.startsWith('env:')) return process.env[value.slice(4)] ?? null
    }
  } catch {
    // 没有这个文件就跳过。
  }
  return null
}

async function resolveDeepseekKey(asrConfig) {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.startsWith('sk-')) {
    return process.env.DEEPSEEK_API_KEY
  }
  const fromDsh = await readDeepseekKeyFromDsh()
  if (fromDsh !== null) return fromDsh
  const fromFile = asrConfig?.deepseek?.apiKey
  return typeof fromFile === 'string' && fromFile.startsWith('sk-') ? fromFile : null
}

async function fetchDeepseekBalance(key) {
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { accept: 'application/json', authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('DeepSeek 余额接口 HTTP ' + response.status)
  const json = await response.json()
  const info = Array.isArray(json?.balance_infos) ? json.balance_infos[0] : null
  if (info === null) throw new Error('DeepSeek 余额接口返回格式异常')
  return {
    available: json.is_available === true,
    currency: typeof info.currency === 'string' ? info.currency : 'CNY',
    total: Number(info.total_balance),
    granted: Number(info.granted_balance),
    toppedUp: Number(info.topped_up_balance),
  }
}

/* ------------------------------------------------------------------ 火山 SigV4 */

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * 火山引擎签名（与 AWS SigV4 同构）。
 * 只覆盖我们用到的 GET/POST + JSON body 场景。
 */
function volcAuthorization({ accessKey, secretKey, method, host, path, query, body, service, region, now }) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const shortDate = xDate.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const canonicalQuery = query
  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' +
    'host:' + host + '\n' +
    'x-content-sha256:' + payloadHash + '\n' +
    'x-date:' + xDate + '\n'
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = shortDate + '/' + region + '/' + service + '/request'
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(secretKey, shortDate), region), service), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    authorization: 'HMAC-SHA256 Credential=' + accessKey + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-sha256': payloadHash, 'x-date': xDate },
  }
}

async function fetchVolcPacks({ accessKey, secretKey }) {
  const host = 'open.volcengineapi.com'
  const service = 'speech_saas_prod'
  const region = 'cn-beijing'
  const query = 'Action=ResourcePacksStatus&Version=2025-05-20'
  const body = JSON.stringify({
    ProjectName: 'default',
    // 录音文件识别（AUC）与流式识别（SAUC）都查；两个都带上，谁有就查谁。
    ResourceIDs: [
      'volc.seedasr.auc',
      'volc.bigasr.auc',
      'volc.seedasr.sauc.duration',
      'volc.bigasr.sauc.duration',
    ],
    Types: ['prepaid', 'quota', 'access', 'free'],
    PageSize: 50,
    PageNumber: 1,
    DisplayRule: 'by_expire',
  })
  const signed = volcAuthorization({
    accessKey, secretKey, method: 'POST', host, path: '/', query, body, service, region, now: new Date(),
  })
  const response = await fetch('https://' + host + '/?' + query, {
    method: 'POST',
    headers: { ...signed.headers, authorization: signed.authorization, host },
    body,
    signal: AbortSignal.timeout(12000),
  })
  const text = await response.text()
  if (!response.ok) {
    let message = text.slice(0, 200)
    try {
      const parsed = JSON.parse(text)
      message = parsed?.ResponseMetadata?.Error?.Message ?? parsed?.error ?? message
    } catch {
      // 原文截断即可。
    }
    throw new Error('火山资源包接口失败：' + message)
  }
  const json = JSON.parse(text)
  const packs = Array.isArray(json?.Result?.Packs) ? json.Result.Packs : []
  // 按资源包算剩余：优先「时长」类（语音识别按小时计），没有就退回第一个有时长的。
  const timePacks = packs
    .map((pack) => {
      const harvest = pack?.Harvest ?? {}
      const unit = String(harvest.Unit ?? pack?.Unit ?? '')
      const purchased = Number(harvest.PurchasedAmount ?? pack?.PurchasedAmount ?? 0)
      const used = Number(harvest.CurrentUsage ?? pack?.CurrentUsage ?? 0)
      const isTime = /时|hour|时间/i.test(unit) || /时|hour/i.test(String(pack?.RawType ?? ''))
      return {
        id: pack?.ResourceID ?? '',
        type: pack?.Type ?? null,
        unit,
        purchased,
        used,
        remaining: Math.max(0, purchased - used),
        isTime,
        expires: pack?.Expires === '-' ? null : (pack?.Expires ?? null),
        state: pack?.State ?? null,
      }
    })
    .filter((pack) => pack.purchased > 0 && pack.state === 'active')
  // 同一个资源可能有多个包（免费额度 + 购买的时长包），全部汇总，展示「总剩余」。
  const round = (value) => Math.round(value * 100) / 100
  const totalRemaining = timePacks.reduce((sum, pack) => sum + pack.remaining, 0)
  const totalPurchased = timePacks.reduce((sum, pack) => sum + pack.purchased, 0)
  const totalUsed = timePacks.reduce((sum, pack) => sum + pack.used, 0)
  const unit = timePacks.find((pack) => pack.unit !== '')?.unit ?? ''
  const remainingLabel = timePacks.length === 0
    ? null
    : (/时/.test(unit) ? round(totalRemaining) + 'h' : round(totalRemaining) + ' ' + unit)
  const summarize = (list) => {
    if (list.length === 0) return null
    const remaining = round(list.reduce((sum, pack) => sum + pack.remaining, 0))
    const purchased = list.reduce((sum, pack) => sum + pack.purchased, 0)
    const used = round(list.reduce((sum, pack) => sum + pack.used, 0))
    const packUnit = list.find((pack) => pack.unit !== '')?.unit ?? ''
    return {
      remaining,
      purchased,
      used,
      unit: packUnit,
      label: /时/.test(packUnit) ? remaining + 'h' : remaining + ' ' + packUnit,
      expires: list.map((pack) => pack.expires).filter((value) => typeof value === 'string').sort()[0] ?? null,
    }
  }
  // 流式（SAUC）与录音文件识别（AUC）额度分开算，界面上也分开显示
  const isStream = (pack) => /sauc/i.test(String(pack.id))
  return {
    packs: timePacks.slice(0, 6),
    remaining: timePacks.length === 0 ? null : round(totalRemaining),
    remainingLabel,
    used: timePacks.length === 0 ? null : round(totalUsed),
    purchased: timePacks.length === 0 ? null : totalPurchased,
    unit: timePacks.length === 0 ? null : unit,
    expires: timePacks.map((pack) => pack.expires).filter((value) => typeof value === 'string').sort()[0] ?? null,
    auc: summarize(timePacks.filter((pack) => !isStream(pack))),
    sauc: summarize(timePacks.filter(isStream)),
  }
}

/* ------------------------------------------------------------------ 对外 */

export function createUsageReader({ getConfigFile }) {
  let cache = { at: 0, value: null }

  async function readAsrConfig() {
    try {
      const file = getConfigFile()
      if (typeof file !== 'string' || file === '') return {}
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return {}
    }
  }

  async function collect() {
    const asrConfig = await readAsrConfig()
    const result = {
      deepseek: { configured: false },
      volc: { configured: false },
    }

    const deepseekKey = await resolveDeepseekKey(asrConfig)
    if (deepseekKey === null) {
      result.deepseek = { configured: false, reason: '没有找到 DeepSeek API Key' }
    } else {
      try {
        const balance = await fetchDeepseekBalance(deepseekKey)
        result.deepseek = { configured: true, ...balance }
      } catch (error) {
        result.deepseek = { configured: true, error: error.message }
      }
    }

    const accessKey = asrConfig?.volcengine?.accessKey
    const secretKey = asrConfig?.volcengine?.secretKey
    if (typeof accessKey !== 'string' || typeof secretKey !== 'string' || accessKey === '' || secretKey === '') {
      result.volc = { configured: false, reason: '没有配置火山 AK/SK（控制台 → 访问控制 → 密钥）' }
    } else {
      try {
        const packs = await fetchVolcPacks({ accessKey, secretKey })
        // 查不到已购买的资源包（例如只有控制台里的免费试用额度）：不显示角标，避免显示成 0 误导
        result.volc = packs.remaining === null
          ? { configured: false, reason: '没有已购买的语音资源包（免费试用额度请在控制台查看）' }
          : { configured: true, ...packs }
      } catch (error) {
        result.volc = { configured: true, error: error.message }
      }
    }
    return result
  }

  return {
    /** 5 分钟内复用；force=true 强制刷新。 */
    async get(force = false) {
      const now = Date.now()
      if (!force && cache.value !== null && now - cache.at < CACHE_MS) return cache.value
      const value = await collect()
      cache = { at: now, value }
      return value
    },
  }
}
