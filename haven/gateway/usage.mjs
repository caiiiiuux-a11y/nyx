// This is a local estimate for choosing how much history to send. Billing uses provider receipts.
export function estimatedUsage(messages, tools = []) {
  const text = JSON.stringify(tools.length ? { messages, tools } : { messages });
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 128) ascii++;
    else other += char.codePointAt(0) > 0xffff ? 3 : 2;
  }
  return { inputTokens: null, outputTokens: null, cachedTokens: null,
    estimatedInputTokens: Math.ceil(ascii / 3) + other + 4, calls: 1 };
}

export function providerUsage(raw = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { inputTokens: count(raw.prompt_tokens), outputTokens: count(raw.completion_tokens),
    cachedTokens: count(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens) };
}

export function combineUsage(first, second) {
  const sum = key => first[key] == null || second[key] == null ? null : first[key] + second[key];
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedTokens: sum('cachedTokens'),
    estimatedInputTokens: sum('estimatedInputTokens'), calls: first.calls + second.calls };
}

// Drop only complete user/assistant pairs. Keep the current input and any tool exchange together.
export function fitHistory(messages, budget, tools = []) {
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
