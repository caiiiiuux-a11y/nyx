import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelRequest, generateMockReply, RECENT_TURN_LIMIT } from './model.mjs';

const user = (text, meta) => ({ from: 'human', text, meta });
const assistant = text => ({ from: 'ai', text });

test('the provider gets the selected model, ordered roles and current input once', () => {
  const request = buildModelRequest({
    model: '月桂',
    messages: [
      user('读到第 37 页了。'), assistant('下次从这里继续。'),
      user('昨天读到哪儿了？', { attachments: [{ name: '窗边的兔子' }] })
    ]
  });
  assert.equal(request.model, '月桂');
  assert.deepEqual(request.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(request.messages.slice(1).map(message => message.content), [
    '读到第 37 页了。', '下次从这里继续。', '昨天读到哪儿了？\n\n[附件：窗边的兔子]'
  ]);
  assert.match(generateMockReply(request).text, /37/);
});

test('context trims oldest complete turns and preserves the current explicit quote', () => {
  const messages = Array.from({ length: RECENT_TURN_LIMIT + 1 }, (_, i) => [user('页' + i), assistant('好')]).flat();
  const current = user('接着读。', { quote: { who: 'Adrian', text: '一段摘录。' } });
  const request = buildModelRequest({ model: '云杉', messages: [...messages, current] });
  assert.equal(request.messages.length, RECENT_TURN_LIMIT * 2 + 2);
  assert.equal(request.messages[1].content, '页1');
  assert.match(request.messages.at(-1).content, /一段摘录。\n\n接着读。/);
  const large = buildModelRequest({ model: '云杉', messages: [user('字'.repeat(24000)), assistant('好'), current] });
  assert.deepEqual(large.messages.map(message => message.role), ['system', 'user']);
});
