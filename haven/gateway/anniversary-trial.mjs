import { createHash } from 'node:crypto';
import { searchConnectedOmbre } from './ombre-search.mjs';

export const anniversaryQuestion = '阿川，我们的纪念日是哪一天？';
const keywords = ['纪念日', '确认恋爱关系'];

function searchConnectedMemory(dashboardOrigin, query, allowed) {
  return searchConnectedOmbre(dashboardOrigin, [query, ...keywords], raw => approvedExcerpt(raw, allowed));
}

// A local selection contains only an ID, length and digest. The characters
// shown in the citation must be read from a direct match in this live call.
export function approvedExcerpt(raw, allowed) {
  const entries = raw.split(/(?=^[^\r\n]*?\[bucket_id:[^\]\r\n]+\][^\r\n]*\r?$)/m);
  for (const entry of entries) {
    const end = entry.indexOf('\n');
    const header = entry.slice(0, end);
    if (end < 0 || !header.includes('[bucket_id:' + allowed.bucketId + ']') || header.includes('非检索命中')) continue;
    const body = entry.slice(end + 1).split(/\r?\n(?:👣 Footprint|---(?:\r?\n|$))/u, 1)[0];
    for (let start = 0; start + allowed.length <= Math.min(body.length, 32768); start++) {
      const excerpt = body.slice(start, start + allowed.length);
      if (createHash('sha256').update(excerpt).digest('hex') === allowed.sha256) {
        return { bucketId: allowed.bucketId, excerpt };
      }
    }
  }
  return null;
}

export function createAnniversaryTrial(thread, dashboardOrigin, allowed, lookup = searchConnectedMemory) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(thread) || !dashboardOrigin ||
      !allowed || typeof allowed.bucketId !== 'string' || !/^[a-z\d_-]{1,80}$/i.test(allowed.bucketId) ||
      !Number.isSafeInteger(allowed.length) || allowed.length < 2 || allowed.length > 160 ||
      typeof allowed.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(allowed.sha256)) {
    throw Error('The anniversary trial requires a window and a short, private excerpt selection.');
  }
  let receipt;
  return { thread, question: anniversaryQuestion,
    tool: { name: 'memory_search', description: '按本轮授权查阅真实 Ombre，以返回的原文核对纪念日。缺少确切日期时如实说明。',
      parameters: { type: 'object', properties: { query: { type: 'string', enum: keywords } }, required: ['query'], additionalProperties: false } },
    search(query) {
      if (!keywords.includes(query)) throw Error('Outside this trial');
      // A retry of this question reuses the confirmed result. A transport failure is retryable.
      return receipt ??= lookup(dashboardOrigin, query, allowed).catch(error => { receipt = undefined; throw error; });
    }
  };
}
