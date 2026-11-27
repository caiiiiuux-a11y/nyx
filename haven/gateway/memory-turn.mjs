import { memoryLabExample as example } from '../room/memory-lab-example.mjs';

const examples = new Map([
  [example.hold, { name: 'hold', arguments: { content: example.fact } }],
  [example.search, { name: 'breath_search', arguments: { query: example.keyword } }],
  [example.dream, { name: 'dream', arguments: {} }]
]);

function toolFor(message) {
  if (message.meta.quote || message.meta.attachments.length) return undefined;
  return examples.get(message.text.trim());
}

function toolDefinition(call) {
  const properties = Object.fromEntries(Object.entries(call.arguments).map(([key, value]) =>
    [key, { type: 'string', enum: [value] }]));
  return {
    name: call.name,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
  };
}

// Lab commands use only the current user message. The mock's answer to a
// recall or dream request must come from the actual tool response.
export function labModelRequest(model, human) {
  const call = toolFor(human);
  return {
    model,
    messages: [{ role: 'user', content: human.text.trim() }],
    tools: call ? [toolDefinition(call)] : []
  };
}

export function mockLabReply(request) {
  const last = request.messages.at(-1);
  if (last.role === 'tool') {
    const receipt = JSON.parse(last.content);
    if (receipt.status !== 'ok') return { text: receipt.text };
    if (last.name === 'hold') return { text: '这件事已经记进隔离测试库了。' };
    const position = receipt.text.indexOf(example.fact);
    if (receipt.bucketId && position >= 0) {
      const excerpt = receipt.text.slice(position, position + example.fact.length);
      const lead = last.name === 'dream' ? '这次做梦时，我又读到了这件事。' : '找到了。';
      return { text: lead + '\n\n' + excerpt };
    }
    // A receipt without this event's provenance is never presented as a hit.
    return { text: last.name === 'dream' ? '这次回顾里没有可确认的纸雀观测站记录。' : '这次没有查到可确认的纸雀观测站记录。' };
  }
  const call = examples.get(last.content);
  if (call && request.tools.some(tool => tool.name === call.name)) {
    return { toolCall: { name: call.name, arguments: { ...call.arguments } } };
  }
  return { text: '这里是隔离记忆实验。可以从聊天里的三个示例，选一句来记下、查找或做梦回看。' };
}

// Keep the first receipt per turn independently of the final model response.
// A lost response after hold may mean the write succeeded: never replay it.
export function createLabTurns(db, lab) {
  db.exec(`CREATE TABLE IF NOT EXISTS lab_tool_receipts (
    turn_id INTEGER PRIMARY KEY, tool TEXT NOT NULL, receipt TEXT
  )`);
  const claim = db.prepare('INSERT OR IGNORE INTO lab_tool_receipts(turn_id,tool) VALUES(?,?)');
  const saved = db.prepare('SELECT tool, receipt FROM lab_tool_receipts WHERE turn_id=?');
  const save = db.prepare('UPDATE lab_tool_receipts SET receipt=? WHERE turn_id=?');

  return async function execute(turnId, human, call) {
    const expected = toolFor(human);
    if (!expected || expected.name !== call.name || !call.arguments ||
        typeof call.arguments !== 'object' || Array.isArray(call.arguments) ||
        Object.keys(expected.arguments).length !== Object.keys(call.arguments).length ||
        !Object.entries(expected.arguments).every(([key, value]) =>
          Object.hasOwn(call.arguments, key) && call.arguments[key] === value)) {
      throw new Error('Tool call outside the selected synthetic example.');
    }
    const uncertain = {
      status: 'uncertain',
      text: '隔离库没有返回可确认的回执。这次调用可能已生效，为避免重复执行，重试这条消息会保留此状态。'
    };
    if (!claim.run(turnId, call.name).changes) {
      const row = saved.get(turnId);
      if (row.tool !== call.name) throw new Error('Tool mismatch for existing turn.');
      return row.receipt ? JSON.parse(row.receipt) : uncertain;
    }
    let receipt;
    try {
      const result = await lab.callTool(call.name, { ...expected.arguments });
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 32768)
        throw new Error('Missing or oversized tool receipt.');
      receipt = { status: 'ok', text: result.text };
      if (typeof result.bucketId === 'string' && result.bucketId.trim() && result.bucketId.length <= 200) {
        receipt.bucketId = result.bucketId;
      }
    } catch {
      receipt = call.name === 'hold' ? uncertain : {
        status: 'error', text: '这次没能从隔离库拿到结果。可以稍后重新发送这条实验消息。'
      };
    }
    save.run(JSON.stringify(receipt), turnId);
    return receipt;
  };
}
