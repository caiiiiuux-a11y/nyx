import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const help = `离线检查 ChatGPT 导出，仅生成清单。
node haven/import/preview.mjs <批次目录> [下一批次目录]

只读目录顶层的 conversations.json 和按编号拆分的 conversations-000.json 等分片。
报告中的节点包括没有消息的树根。第二批只与第一批比较。previousOnly 表示本批未出现。
不会写入聊天库，也不会输出标题、正文或本机路径。
退出码 0 检查通过，1 用法或目录错误，2 部分分片、记录或分支需要人工核对。`;
const shardName = /^conversations(?:[-_.](\d+))?\.json$/i;
const validId = value => typeof value === 'string' && value.length <= 256 && /^\S+$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = values => [...values].sort();
const knownRoles = new Set(['user', 'assistant', 'system', 'developer', 'tool', 'function']);

function messageDigest(message) {
  // Compare fields needed to replay the message. Export bookkeeping and feedback
  // may change in a later snapshot while the original conversation stays identical.
  const replay = message && {
    author: { role: message.author?.role, name: message.author?.name },
    content: message.content, recipient: message.recipient, channel: message.channel,
    attachments: message.metadata?.attachments, citations: message.metadata?.citations,
    contentReferences: message.metadata?.content_references
  };
  return createHash('sha256').update(JSON.stringify(replay, (_, value) =>
    record(value) ? Object.fromEntries(sorted(Object.keys(value)).map(k => [k, value[k]])) : value
  )).digest('hex');
}

function addNode(conv, id, raw, file, issues) {
  const where = { file, conversationId: conv.id, nodeId: id };
  const issue = code => issues.push({ code, ...where });
  if (!record(raw)) return issue('unrecognized_node');
  if (raw.id !== undefined && raw.id !== id) issue('node_id_mismatch');
  const parent = raw.parent === null || validId(raw.parent) ? raw.parent : undefined;
  if (parent === undefined) issue('invalid_parent');
  const message = raw.message;
  if (message !== null && !record(message)) return issue('unrecognized_message');
  const messageId = validId(message?.id) ? message.id : null;
  const role = knownRoles.has(message?.author?.role) ? message.author.role : null;
  if (message && !messageId) issue('missing_message_id');
  if (message && !role) issue('unknown_role');
  let node = conv.nodes.get(id);
  if (!node) {
    node = { id, children: new Set(), variants: new Map() };
    conv.nodes.set(id, node);
  }
  if (raw.children !== undefined && !Array.isArray(raw.children)) issue('invalid_children');
  for (const child of Array.isArray(raw.children) ? raw.children : []) {
    if (validId(child)) node.children.add(child);
    else issue('invalid_child');
  }
  const digest = messageDigest(message);
  const key = JSON.stringify([parent ?? null, messageId, digest]);
  let version = node.variants.get(key);
  if (!version) {
    if (node.variants.size) issue('conflicting_node');
    version = { parent, messageId, role, hasMessage: message !== null, files: new Set() };
    node.variants.set(key, version);
  }
  version.files.add(file);
}

function addConversation(conversations, raw, file, index, issues) {
  const where = { file, index };
  if (!record(raw)) return issues.push({ code: 'unrecognized_conversation', ...where });
  const id = raw.conversation_id ?? raw.id;
  if (!validId(id)) return issues.push({ code: 'missing_conversation_id', ...where });
  if (raw.id != null && raw.conversation_id != null && raw.id !== raw.conversation_id) {
    return issues.push({ code: 'conversation_id_mismatch', ...where });
  }
  if (!record(raw.mapping) || !Object.keys(raw.mapping).length) {
    return issues.push({ code: 'missing_mapping', ...where, conversationId: id });
  }
  let conv = conversations.get(id);
  if (!conv) {
    conv = { id, nodes: new Map(), active: new Set(), messageNodes: new Map() };
    conversations.set(id, conv);
  }
  if (raw.current_node != null) {
    if (validId(raw.current_node)) conv.active.add(raw.current_node);
    else issues.push({ code: 'invalid_active_node', ...where, conversationId: id });
  }
  for (const [key, node] of Object.entries(raw.mapping)) {
    if (validId(key)) addNode(conv, key, node, file, issues);
    else issues.push({ code: 'invalid_node_id', ...where, conversationId: id });
  }
}

function inspectTree(conv, issues) {
  const issue = (code, fields = {}) => issues.push({ code, conversationId: conv.id, ...fields });
  const parents = new Map();
  for (const node of conv.nodes.values()) {
    for (const v of node.variants.values()) {
      if (v.messageId) {
        const previous = conv.messageNodes.get(v.messageId);
        if (previous && previous !== node.id) issue('duplicate_message_id', { nodeId: node.id, otherNodeId: previous });
        else conv.messageNodes.set(v.messageId, node.id);
      }
      if (v.parent) {
        const parent = conv.nodes.get(v.parent);
        if (parent) parent.children.add(node.id);
        else issue('missing_parent', { nodeId: node.id, parent: v.parent });
      }
      if (node.variants.size === 1) parents.set(node.id, v.parent);
    }
  }
  for (const node of conv.nodes.values()) {
    for (const child of node.children) {
      if (!conv.nodes.has(child)) issue('missing_child', { nodeId: node.id, child });
      else if (parents.has(child) && parents.get(child) !== node.id) issue('conflicting_edge', { nodeId: node.id, child });
    }
  }
  const checked = new Set();
  for (const id of parents.keys()) {
    if (checked.has(id)) continue;
    const path = new Set();
    let cursor = id;
    while (cursor && parents.has(cursor) && !checked.has(cursor)) {
      if (path.has(cursor)) { issue('parent_cycle', { nodeId: cursor }); break; }
      path.add(cursor);
      cursor = parents.get(cursor);
    }
    for (const visited of path) checked.add(visited);
  }
  for (const id of conv.active) if (!conv.nodes.has(id)) issue('missing_active_node', { nodeId: id });
  const leaves = [...conv.nodes.values()].filter(node => !node.children.size);
  if (conv.active.size > 1 || (!conv.active.size && leaves.length > 1)) issue('ambiguous_active_branch');
}

function nodeReport(node) {
  const versions = [...node.variants.values()].map(v => ({
    parent: v.parent, messageId: v.messageId, role: v.role, files: sorted(v.files)
  }));
  const fields = versions.length === 1 ? versions[0] : { variants: versions };
  return { id: node.id, children: sorted(node.children), ...fields };
}

async function loadBatch(directory, number) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => shardName.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const issues = [], files = [], conversations = new Map();
  const indices = [];
  for (const entry of entries) {
    const file = entry.name;
    const suffix = shardName.exec(file)[1];
    if (suffix !== undefined) {
      const index = Number(suffix);
      if (Number.isSafeInteger(index)) indices.push(index);
      else issues.push({ code: 'invalid_shard_number', file });
    }
    if (!entry.isFile()) {
      issues.push({ code: 'not_regular_file', file });
      files.push({ name: file, status: 'skipped' });
      continue;
    }
    let raw;
    try { raw = JSON.parse((await readFile(join(directory, file), 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) {
      issues.push({ code: error instanceof SyntaxError ? 'invalid_json' : 'unreadable_file', file });
      files.push({ name: file, status: 'failed' });
      continue;
    }
    const records = Array.isArray(raw) ? raw : [raw];
    records.forEach((conv, index) => addConversation(conversations, conv, file, index, issues));
    files.push({ name: file, status: 'parsed', recordCount: records.length });
  }
  if (!entries.length) issues.push({ code: 'no_conversation_files' });
  if (indices.length && entries.some(e => /^conversations\.json$/i.test(e.name))) issues.push({ code: 'mixed_shard_formats' });
  indices.sort((a, b) => a - b);
  if (indices[0] > 1) issues.push({ code: 'unexpected_first_shard', first: indices[0] });
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1]) issues.push({ code: 'duplicate_shard_number', index: indices[i] });
    if (indices[i] > indices[i - 1] + 1) {
      issues.push({ code: 'shard_gap', firstMissing: indices[i - 1] + 1, lastMissing: indices[i] - 1 });
    }
  }
  const manifest = [];
  for (const id of sorted(conversations.keys())) {
    const conv = conversations.get(id);
    inspectTree(conv, issues);
    manifest.push({ id, activeNodeIds: sorted(conv.active), nodes: sorted(conv.nodes.keys()).map(k => nodeReport(conv.nodes.get(k))) });
  }
  return { conversations, report: { batch: number, files, conversations: manifest, issues } };
}

function compare(first, next) {
  const result = { newConversations: [], appended: [], duplicates: [], conflicts: [], previousOnly: [] };
  for (const id of sorted(new Set([...first.keys(), ...next.keys()]))) {
    const a = first.get(id), b = next.get(id);
    if (!a) { result.newConversations.push(id); continue; }
    const added = [], same = [], absent = [];
    for (const key of sorted(new Set([...a.nodes.keys(), ...(b?.nodes.keys() ?? [])]))) {
      const old = a.nodes.get(key), now = b?.nodes.get(key);
      if (!now) { absent.push(key); continue; }
      const reassigned = [...now.variants.values()].some(v =>
        v.messageId && a.messageNodes.has(v.messageId) && a.messageNodes.get(v.messageId) !== key);
      if (reassigned) {
        result.conflicts.push({ conversationId: id, nodeId: key, kind: 'reassigned_message_id' });
        continue;
      }
      if (!old) {
        if (now.variants.size > 1) result.conflicts.push({ conversationId: id, nodeId: key, kind: 'changed_or_ambiguous_node' });
        else added.push(key);
        continue;
      }
      if (old.variants.size === 1 && now.variants.size === 1 && old.variants.has(now.variants.keys().next().value)) same.push(key);
      else result.conflicts.push({ conversationId: id, nodeId: key, kind: 'changed_or_ambiguous_node' });
    }
    for (const [group, nodeIds] of [[result.appended, added], [result.duplicates, same], [result.previousOnly, absent]]) {
      if (nodeIds.length) group.push({ conversationId: id, nodeIds });
    }
  }
  return result;
}

function summarize(data, comparison) {
  const batches = data.map(({ report, conversations }) => {
    let messageNodes = 0;
    for (const conv of conversations.values()) {
      for (const node of conv.nodes.values()) {
        if ([...node.variants.values()].some(v => v.hasMessage)) messageNodes++;
      }
    }
    return { batch: report.batch, shardFiles: report.files.length, conversations: conversations.size,
      messageNodes, issues: report.issues.length };
  });
  if (!comparison) return { batches };
  const count = group => group.reduce((n, row) => n + row.nodeIds.length, 0);
  return { batches, comparison: {
    newConversations: comparison.newConversations.length,
    appendedNodes: count(comparison.appended), duplicateNodes: count(comparison.duplicates),
    conflictingNodes: comparison.conflicts.length, previousOnlyNodes: count(comparison.previousOnly)
  } };
}

async function main(args) {
  if (args.length === 1 && ['--help','-h'].includes(args[0])) { console.log(help); return; }
  if (args.length < 1 || args.length > 2 || args.some(arg => arg.startsWith('-'))) {
    console.error(help); process.exitCode = 1; return;
  }
  const data = [];
  for (const [i, directory] of args.entries()) {
    try { data.push(await loadBatch(directory, i + 1)); }
    catch {
      console.error(`无法完成第 ${i + 1} 批目录检查。请核对目录和读取权限。`);
      process.exitCode = 1; return;
    }
  }
  const comparison = data.length === 2 ? compare(data[0].conversations, data[1].conversations) : null;
  const batches = data.map(b => b.report);
  const summary = summarize(data, comparison);
  console.log(JSON.stringify({ version: 1, dryRun: true, summary, batches, comparison }, null, 2));
  if (batches.some(b => b.issues.length) || comparison?.conflicts.length) process.exitCode = 2;
}

await main(process.argv.slice(2));
