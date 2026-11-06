/**
 * 火山「录音文件识别」2.0（volc.seedasr.auc）：整段音频转写。
 *
 * 提交用 `audio.data`（base64），不需要先把音频传到对象存储；
 * 提交后按 task_id 轮询查询接口，拿到 result.text / utterances。
 * 消耗的是「豆包录音文件识别模型 2.0」的时长包（控制台买的录音包）。
 */
import { randomUUID } from 'node:crypto'

const SUBMIT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
const QUERY_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'
const RESOURCE_ID = 'volc.seedasr.auc'

function headersFor(apiKey, requestId, extra = {}) {
  return {
    'content-type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': RESOURCE_ID,
    'X-Api-Request-Id': requestId,
    ...extra,
  }
}

/**
 * 转写整段音频。
 * @param audioBuffer - 音频文件内容（wav/mp3/ogg）。
 * @param options - { apiKey, format, language, pollMs, timeoutMs }。
 * @returns { text, utterances: [{ text, start, end }], durationMs, status }
 */
export async function transcribeVolcAuc(audioBuffer, options = {}) {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (apiKey === '') throw Object.assign(new Error('asr.json 里没有火山 apiKey'), { code: 'no_asr_key' })
  const format = typeof options.format === 'string' && options.format !== '' ? options.format : 'wav'
  const language = typeof options.language === 'string' && options.language !== '' ? options.language : 'zh-CN'
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1500
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000

  const submitId = randomUUID()
  const submit = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: headersFor(apiKey, submitId, { 'X-Api-Sequence': '-1' }),
    body: JSON.stringify({
      user: { uid: 'dsh-cost-workbench' },
      audio: { data: audioBuffer.toString('base64'), format },
      request: { language, model_name: 'bigmodel', show_utterances: true },
    }),
    signal: AbortSignal.timeout(120000),
  })
  const submitCode = submit.headers.get('x-api-status-code') ?? ''
  if (submitCode !== '20000000') {
    const message = submit.headers.get('x-api-message') ?? ('HTTP ' + submit.status)
    throw Object.assign(new Error('火山录音文件识别提交失败：' + message), { code: 'auc_submit_failed' })
  }
  const taskId = submit.headers.get('x-api-request-id') ?? submitId

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    const query = await fetch(QUERY_URL, {
      method: 'POST',
      headers: headersFor(apiKey, taskId),
      body: '{}',
      signal: AbortSignal.timeout(120000),
    })
    const code = query.headers.get('x-api-status-code') ?? ''
    const message = query.headers.get('x-api-message') ?? ''
    let json = null
    try {
      json = await query.json()
    } catch {
      json = null
    }
    // 20000000 = 成功；20000003 = 无有效语音（也算完成，返回空文本）
    if (code === '20000000' || code === '20000003') {
      const result = json !== null && typeof json === 'object' && json.result !== null && typeof json.result === 'object' ? json.result : {}
      const text = typeof result.text === 'string' ? result.text : ''
      const rawUtterances = Array.isArray(result.utterances) ? result.utterances : []
      const utterances = rawUtterances
        .map((item) => ({
          text: String(item?.text ?? '').trim(),
          start: Number(item?.start_time ?? item?.start ?? 0),
          end: Number(item?.end_time ?? item?.end ?? 0),
        }))
        .filter((item) => item.text !== '')
      return {
        text,
        utterances: utterances.length > 0 ? utterances : (text.trim() === '' ? [] : [{ text: text.trim(), start: 0, end: 0 }]),
        durationMs: Number(json?.audio_info?.duration ?? 0),
        status: code === '20000003' ? 'silence' : 'ok',
      }
    }
    // 20000001 / 20000002 = 排队 / 处理中，继续轮询
    if (code === '20000001' || code === '20000002') continue
    if (code === '' && query.status >= 400) {
      throw Object.assign(new Error('火山录音文件识别查询失败：HTTP ' + query.status), { code: 'auc_query_failed' })
    }
    if (code !== '') {
      throw Object.assign(new Error('火山录音文件识别失败：' + (message || code)), { code: 'auc_query_failed' })
    }
  }
  throw Object.assign(new Error('火山录音文件识别超时（任务未完成）'), { code: 'auc_timeout' })
}
