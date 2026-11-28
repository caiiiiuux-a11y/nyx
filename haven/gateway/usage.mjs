// This is a local estimate for choosing how much history to send. Billing uses provider receipts.
function estimateText(text) {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 128) ascii++;
    else other += char.codePointAt(0) > 0xffff ? 3 : 2;
  }
  return Math.ceil(ascii / 3) + other;
}

export function estimatedOutput(result) {
  if (!result || (typeof result.text !== 'string' && !result.toolCall)) return null;
  const call = result.toolCall;
  const toolText = call ? JSON.stringify({ name: call.name, arguments: call.arguments }) : '';
  return estimateText((result.text ?? '') + toolText);
}

export function estimatedUsage(messages, tools = [], result) {
  const text = JSON.stringify(tools.length ? { messages, tools } : { messages });
  return { inputTokens: null, outputTokens: null, totalTokens: null, cachedTokens: null, cacheWriteTokens: null,
    estimatedInputTokens: estimateText(text) + 4, estimatedOutputTokens: estimatedOutput(result), calls: 1 };
}

// Some streams publish cumulative, partial receipts. Replace reported counters and keep
// previous values for omitted fields. Cached input is already counted in the input total.
export function providerUsage(raw, previous = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const details = raw.prompt_tokens_details;
  const amount = raw.cost?.amount ?? raw.cost_usd ?? raw.cost;
  const currency = raw.cost?.currency ?? (raw.cost_usd != null ? 'USD' : raw.cost_currency ?? raw.currency);
  const cost = Number.isFinite(amount) && amount >= 0 && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
    ? { amount, currency } : previous.cost ?? null;
  return { inputTokens: count(raw.prompt_tokens) ?? previous.inputTokens ?? null,
    outputTokens: count(raw.completion_tokens) ?? previous.outputTokens ?? null,
    totalTokens: count(raw.total_tokens) ?? previous.totalTokens ?? null,
    cachedTokens: count(details?.cached_tokens ?? raw.prompt_cache_hit_tokens) ?? previous.cachedTokens ?? null,
    cacheWriteTokens: count(details?.cache_write_tokens ?? raw.cache_creation_input_tokens) ?? previous.cacheWriteTokens ?? null,
    cost };
}

export function averageSpeed(outputTokens, durationMs) {
  return outputTokens != null && durationMs > 0 ? outputTokens * 1000 / durationMs : null;
}

export function combineUsage(first, second, beforeSecondMs) {
  const sum = key => first[key] == null || second[key] == null ? null : first[key] + second[key];
  const offset = value => beforeSecondMs == null || value == null ? null : beforeSecondMs + value;
  const durationMs = offset(second.durationMs);
  const outputTokens = sum('outputTokens');
  const cost = first.cost && second.cost && first.cost.currency === second.cost.currency
    ? { amount: first.cost.amount + second.cost.amount, currency: first.cost.currency } : null;
  return { inputTokens: sum('inputTokens'), outputTokens, totalTokens: sum('totalTokens'),
    cachedTokens: sum('cachedTokens'), cacheWriteTokens: sum('cacheWriteTokens'), cost,
    estimatedInputTokens: sum('estimatedInputTokens'), estimatedOutputTokens: sum('estimatedOutputTokens'),
    ...(typeof first.windowKeySent === 'boolean' && first.windowKeySent === second.windowKeySent &&
      { windowKeySent: first.windowKeySent }),
    firstResponseMs: first.firstResponseMs ?? null, firstOutputMs: offset(second.firstOutputMs), durationMs,
    tokensPerSecond: averageSpeed(outputTokens, durationMs), calls: first.calls + second.calls };
}

// Drop only complete user/assistant pairs. Keep the current input and any tool exchange together.
export function fitHistory(messages, budget, tools = []) {
  if (budget === 0) return messages;
  const fitted = [...messages];
  while (estimatedUsage(fitted, tools).estimatedInputTokens > budget) {
    if (fitted.length < 4 || fitted[0].role !== 'system' || fitted[1].role !== 'user' ||
        fitted[2].role !== 'assistant' || fitted[2].toolCall || fitted[3].role !== 'user') {
      throw new RangeError('这条消息和必要上下文超过了本窗口的输入预算。请缩短消息，或调高预算后再发。');
    }
    fitted.splice(1, 2);
  }
  return fitted;
}

export class ProviderContextError extends RangeError {
  constructor() {
    super('这次请求超出了模型线路可接收的长度。请降低本窗输入预算或缩短消息后重试。');
  }
}
