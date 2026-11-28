import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveRoutes } from './live-routes.mjs';
import { openStore } from './store.mjs';

test('a new live window receives original statements from its own provider and cites each actual excerpt', async t => {
  const requests = [];
  let reply = '收到。';
  const routes = createLiveRoutes({ fetchImpl: async (url, options) => {
    if (options.method === 'GET') return Response.json({ data: [{id:'shared'}, {id:'other'}] });
    requests.push({ host: url.host, payload: JSON.parse(options.body) });
    const chunk = { choices: [{ delta: {content: reply}, finish_reason: 'stop' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
      headers: {'content-type': 'text/event-stream'}
    });
  }});
  const store = openStore(':memory:', { models: routes.active('mock').models, modelsForRoute: id => routes.active(id).models,
    complete: routes.complete, resumePendingOnRead: false, embedder: false });
  t.after(() => store.close());
  const {addedRoute: a} = await routes.add(store, {label:'甲',baseURL:'http://127.0.0.1:1234/v1'});
  const {addedRoute: b} = await routes.add(store, {label:'乙',baseURL:'http://127.0.0.1:5678/v1'});
  const select = (thread, route, model='shared') => routes.select(store,{thread,route,model});
  const send = (thread, requestId, text) => store.send({thread,requestId,text});
  select('window', a);
  const fact = '博物馆给紫色邮筒取了名字「月湖壹号」。';
  const followup = '它放在陈列区的第 42 号柜。';
  const q = '我们刚才给紫色邮筒取了什么名字？它放在几号柜？请只回名字和柜号。';
  const first = await send('window','first',fact);
  const second = await send('window','second',followup);
  reply = '没有找到相关记录。';
  await send('window','earlier-question',q);
  const newThread = store.createWindow({}).window.id;
  select(newThread, a, 'other');
  reply = '月湖壹号，42 号柜。';
  const answer = await send(newThread,'recall',q);
  const wire = requests.at(-1).payload;
  assert.equal(wire.model, 'other');
  assert.equal(wire.messages.length, 2);
  const transmitted = wire.messages.at(-1).content;
  assert.ok(transmitted.includes(fact) && transmitted.includes(followup));
  assert.ok(!transmitted.includes('没有找到相关记录。'));
  const refs = answer.messages[1].meta.sourceRefs;
  assert.deepEqual(refs.map(ref => ref.messageId).sort(), [first.messages[0].id,second.messages[0].id]);
  assert.ok(refs.every(r => r.thread === 'window' && r.from === 'human' && transmitted.includes(r.excerpt)));
  assert.equal(answer.messages[1].meta.archiveMode, 'lexical');
  // A new provider shares a model ID, but neither recent context nor retrieved evidence.
  select(newThread, b);
  await send(newThread,'foreign',q);
  assert.equal(requests.at(-1).host, '127.0.0.1:5678');
  assert.ok(!JSON.stringify(requests.at(-1).payload).includes('月湖'));
  assert.ok(!JSON.stringify(requests.at(-1).payload).includes('42'));
  assert.equal(requests.at(-1).payload.messages.length, 2);
  assert.match(requests.at(-1).payload.messages.at(-1).content,/没有可引用/);
  await assert.rejects(store.regenerate({thread:newThread, id:answer.messages[1].id, requestId:'other-route'}), {status:409});
});
