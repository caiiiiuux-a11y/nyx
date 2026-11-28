const hasCount = value => Number.isSafeInteger(value) && value >= 0;
const format = new Intl.NumberFormat('zh-CN');
const seconds = ms => (ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' s';

export function usageReceipt(usage, offline) {
  if (!usage) return offline
    ? { label: '本地示例', note: '这条示例回复在浏览器里生成，没有模型请求。', rows: [] }
    : { label: '用量未记录', note: '生成这条回复时没有保存用量回执。', rows: [] };
  const { inputTokens, outputTokens, cachedTokens, cacheWriteTokens, estimatedInputTokens, estimatedOutputTokens } = usage;
  const total = hasCount(usage.totalTokens) ? usage.totalTokens :
    hasCount(inputTokens) && hasCount(outputTokens) ? inputTokens + outputTokens : null;
  let label = '用量明细';
  const input = hasCount(inputTokens) ? inputTokens : estimatedInputTokens;
  const output = hasCount(outputTokens) ? outputTokens : estimatedOutputTokens;
  if (hasCount(total)) label = format.format(total) + ' tokens';
  else if (hasCount(input) && hasCount(output)) label = '约 ' + format.format(input + output) + ' tokens';
  else if (hasCount(input)) label = (hasCount(inputTokens) ? '输入 ' : '输入约 ') + format.format(input) + ' tokens';
  else if (hasCount(output)) label = (hasCount(outputTokens) ? '输出 ' : '输出约 ') + format.format(output) + ' tokens';

  function count(actual, estimate) {
    if (hasCount(actual)) return format.format(actual);
    return hasCount(estimate) ? '约 ' + format.format(estimate) : '未回报';
  }
  const rows = [
    ['输入', count(inputTokens, estimatedInputTokens)], ['输出', count(outputTokens, estimatedOutputTokens)],
    ['缓存命中', count(cachedTokens)], ['缓存写入', count(cacheWriteTokens)]
  ];
  if (Number.isFinite(usage.tokensPerSecond)) rows.push(['平均速度',
    usage.tokensPerSecond.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' tok/s']);
  for (const [name, ms] of [['首响应', usage.firstResponseMs], ['首段正文', usage.firstOutputMs], ['总耗时', usage.durationMs]]) {
    if (Number.isFinite(ms) && ms >= 0) rows.push([name, seconds(ms)]);
  }
  if (Number.isFinite(usage.cost?.amount) && /^[A-Z]{3}$/.test(usage.cost.currency)) {
    rows.push(['费用', usage.cost.currency + ' ' + usage.cost.amount.toLocaleString('zh-CN', {maximumFractionDigits: 10})]);
  }
  if (typeof usage.windowKeySent === 'boolean') rows.push(['窗口缓存键', usage.windowKeySent ? '已发送' : '未发送']);
  if (usage.calls > 1) rows.push(['模型调用', format.format(usage.calls) + ' 次']);
  return { label, rows };
}
