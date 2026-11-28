import assert from 'node:assert/strict';
import test from 'node:test';
import { validDay } from '../room/diary-records.mjs';
import { createLiveRoutes } from './live-routes.mjs';
import { openStore } from './store.mjs';

test('meal and period stickers validate civil dates, protect concurrent edits and report only month flags', t => {
  const store = openStore(':memory:', { enableCalendar: true, embedder: false });
  t.after(() => store.close());
  const { calendar } = store;
  const date = '2028-02-29';
  assert.ok(validDay(date));
  for (const bad of ['2027-02-29', '2028-02-30', '2028-2-29', {}, null]) assert.equal(validDay(bad), false);
  const meal = { date, field: 'lunch', value: '桂花藕粉', previous: '' };
  assert.deepEqual(calendar.save(meal), calendar.save(meal));
  calendar.save({ date, field: 'period', value: 'ongoing', previous: '' });
  assert.throws(() => calendar.save({ ...meal, value: '新餐' }), { status: 409 });
  assert.throws(() => calendar.save({ ...meal, field: ['lunch'] }), { status: 400 });
  assert.throws(() => calendar.save({ ...meal, field: 'period' }), { status: 400 });
  const tomorrow = '2028-03-01';
  calendar.save({ ...meal, date: tomorrow, value: '米糕' });
  assert.deepEqual(calendar.month('2028-02', 'gemini').marks, { [date]: { meals: true, period: true } });
  assert.deepEqual(calendar.read({ date, category: 'meals' }).evidence.records, ['午餐　桂花藕粉']);
  assert.deepEqual(calendar.read({ date, category: 'period' }).evidence.records, ['经期中']);
  assert.equal(calendar.read({ date: tomorrow, category: 'meals' }, date).receipt.status, 'error');
  assert.equal(calendar.read({ date, category: 'all' }).receipt.status, 'error');
  calendar.save({ ...meal, previous: '桂花藕粉', value: '' });
  assert.equal(calendar.read({ date, category: 'meals' }).receipt.status, 'empty');
  assert.deepEqual(calendar.month('2028-02').marks, { [date]: { period: true } });
});

const model = 'vertex_ai/gemini-test';
function stream(delta, finish_reason = 'stop') {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

test('a story stays in its book across dates and retries without marking the diary or the memo board', async t => {
  let store, calls = 0;
  const routes = createLiveRoutes({ baseURL: 'https://fixture.example/v1', model, apiKey: 'fixture-key',
    readCalendar: () => assert.fail('Story requested calendar data'),
    personalMemory: { listTools: () => assert.fail('Story requested tools'), surface: () => assert.fail('Story requested a memory') },
    fetchImpl: async (_, opts) => {
      const body = JSON.parse(opts.body);
      assert.match(body.messages[0].content, /故事本/);
      assert.equal(body.tools, undefined);
      if (++calls === 1) return new Response(null, { status: 502 });
      if (body.messages.at(-1).content === '请接着讲。') {
        assert.ok(body.messages.some(m => m.role === 'assistant' && m.content === '纸船向着月亮开去。'));
        return stream({ content: '纸船又驶过一座桥。' });
      }
      return stream({ content: '纸船向着月亮开去。' });
    } });
  store = openStore(':memory:', { enableCalendar: true, complete: routes.complete, models: ['iris-demo-a'],
    modelsForRoute: id => routes.active(id).models, embedder: false, resumePendingOnRead: false });
  t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  const target = routes.calendarTarget(store);
  assert.equal(store.calendar.storyThreadFor(target.route), undefined);
  const thread = store.calendar.openStorybook(target);
  assert.equal(store.calendar.openStorybook(target), thread);
  assert.equal(store.calendar.storyThreadFor('other'), undefined);
  assert.ok(!store.listWindows().windows.some(w => w.id === thread));
  const draft = { thread, requestId: 'moon-story', text: '讲一个纸船的故事。' };
  await assert.rejects(store.send(draft), { status: 503 });
  assert.equal((await store.history({ thread })).messages[0].meta.retryRequestId, draft.requestId);
  const sent = await store.send(draft);
  assert.deepEqual(await store.send(draft), sent);
  assert.equal(calls, 2);
  assert.equal((await store.history({ thread })).messages.at(-1).text, '纸船向着月亮开去。');
  const sequel = await store.send({ thread, requestId: 'moon-story-next', text: '请接着讲。' });
  assert.equal(sequel.messages.at(-1).text, '纸船又驶过一座桥。');
  assert.deepEqual(store.calendar.month('2026-11', target.route).marks, {});
});

test('date-bound and ordinary Gemini chats use the same calendar tool, with separate history, scopes and durable receipts', async t => {
  const date = '2026-11-26', other = '2026-11-25';
  let store, surfaces = 0, reads = 0, failAnswer = false, chosenDate = date;
  const requests = [];
  function call(name,args) {
    return stream({ tool_calls: [{ id: 'k-' + name, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  }
  const routes = createLiveRoutes({ baseURL: 'https://fixture.example/v1', model, apiKey: 'fixture-key',
    personalMemory: { listTools: () => [{ name: 'breath', parameters: { type: 'object', properties: {} } }],
      surface() { surfaces++; return null; } },
    readCalendar(args, bound, route) { reads++; return store.calendar.read(args, bound, route); },
    fetchImpl: async (_, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      const last = body.messages.at(-1);
      if (body.tool_choice?.function?.name === 'calendar_reply') return call('calendar_reply', { date, text: '回执里是紫薯米糕。' });
      if (last.role === 'tool') {
        if (failAnswer) { failAnswer = false; return new Response(null, { status: 502 }); }
        const data = JSON.parse(last.content);
        if (data.posted) return stream({ content: '给你贴好了。' });
        if (body.tools.some(t => t.function.parameters.properties.date?.enum)) {
          return call('calendar_reply', { date, text: data.records?.join('、') || '没有可引用的记录。' });
        }
        return stream({ content: data.records?.join('、') || '当天还没记。' });
      }
      if (last.content.startsWith('请贴')) return call('calendar_reply', { date: other, text: '窗台上有一颗星。' });
      return call('calendar_read', { date: chosenDate, category: 'meals' });
    } });
  store = openStore(':memory:', { complete: routes.complete, models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, resumePendingOnRead: false, enableCalendar: true, embedder: false });
  t.after(() => store.close());
  routes.select(store, { route: 'gemini', model });
  routes.setMemorySource(store, { route: 'gemini', source: 'personal' });
  const target = routes.calendarTarget(store);
  assert.deepEqual(target, { route: 'gemini', model, ready: true });
  const thread = store.calendar.openDay(date, target);
  assert.equal(store.calendar.openDay(date, target), thread);
  assert.ok(!store.listWindows().windows.some(w => w.id === thread));
  assert.deepEqual((await routes.toolList(store)).groups.map(g => g.id), ['ombre', 'calendar']);
  assert.deepEqual((await routes.toolList(store, thread)).groups.map(g => g.id), ['calendar']);
  store.calendar.save({ date, field: 'lunch', value: '紫薯米糕', previous: '' });
  store.calendar.save({ date, field: 'period', value: 'end', previous: '' });
  store.calendar.save({ date: other, field: 'lunch', value: '桂花藕粉', previous: '' });
  const draft = { thread, text: '午餐吃了什么？', requestId: 'page' };
  failAnswer = true;
  await assert.rejects(store.send(draft), { status: 503 });
  assert.equal((await store.history({ thread })).messages[0].meta.retryRequestId, draft.requestId);
  assert.deepEqual(requests[0].tools.map(t => t.function.name), ['calendar_read', 'calendar_reply', 'calendar_note']);
  const [, diaryTool, noteTool] = requests[0].tools.map(t => t.function);
  assert.match(diaryTool.description, /日记本/);
  assert.match(diaryTool.parameters.properties.text.description, /第一人称日记/);
  assert.match(noteTool.parameters.properties.text.description, /写给 Iris 的便签/);
  assert.deepEqual(requests[0].tools[0].function.parameters.properties.date.enum, [date]);
  assert.doesNotMatch(JSON.stringify(requests[0]), /桂花藕粉|紫薯米糕|结束了/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /桂花藕粉|结束了/);
  const resumed = await store.send(draft);
  assert.match(requests.at(-1).messages.at(-1).content, /第一人称写这一天的日记/);
  const [receipt, star] = resumed.messages[1].meta.memoryTools;
  assert.deepEqual(receipt, { name: 'calendar_read', scope: 'calendar', date, category: 'meals', status: 'ok', output: '午餐　紫薯米糕' });
  assert.equal(star.name, 'calendar_reply');
  assert.equal(resumed.messages[1].text, star.output);
  assert.equal(reads, 1);
  assert.equal(surfaces, 0);
  assert.deepEqual(await store.send(draft), resumed);
  assert.ok(store.calendar.month('2026-11', 'gemini').marks[date].star);
  const count = requests.length;
  assert.deepEqual((await store.history({ thread })).messages, resumed.messages);
  assert.equal(requests.length, count);
  chosenDate = other;
  const [, rejected] = (await store.send({ ...draft, requestId: 'other-day' })).messages;
  assert.equal(rejected.meta.memoryTools[0].status, 'error');
  assert.doesNotMatch(JSON.stringify(requests.slice(count)), /桂花藕粉/);
  const ordinaryStart = requests.length;
  const [, answer] = (await store.send({ thread: 'window', text: '11 月 25 日的午餐记了什么？', requestId: 'chat' })).messages;
  assert.match(answer.text, /桂花藕粉/);
  assert.equal(answer.meta.memoryTool.date, other);
  assert.equal(surfaces, 1);
  assert.doesNotMatch(JSON.stringify(requests.slice(ordinaryStart)), /紫薯米糕|结束了/);
  const note = { thread: 'window', text: '请贴一颗纸星。', requestId: 'star' };
  const sent = await store.send(note);
  assert.equal(sent.messages[1].meta.memoryTool.name, 'calendar_reply');
  assert.deepEqual(await store.send(note), sent);
  assert.deepEqual(store.calendar.stars(other, 'gemini').map(s => s.text), ['窗台上有一颗星。']);
  assert.equal(store.calendar.stars(date, 'gemini', thread).length, 0);
  const blocked = store.calendar.post({ date: other, text: '跨页' }, { boundDate: date, turnId: 1, thread, route: 'gemini' });
  assert.equal(blocked.receipt.status, 'error');

  chosenDate = date;
  failAnswer = true;
  await assert.rejects(store.send({ ...draft, requestId: 'interrupted-entry' }), { status: 503 });
  const pending = (await store.history({ thread })).messages.at(-1);
  assert.equal(pending.meta.retryRequestId, 'interrupted-entry');
  // Recreate a shutdown between saving the tool's entry and committing the final chat answer.
  store.calendar.post({ date, text: '已经写进本子的那一句。' },
    { boundDate: date, turnId: (pending.id + 1) / 2, thread, route: 'gemini' });
  assert.deepEqual(store.calendar.stars(date, 'gemini', thread).map(s => s.text), ['已经写进本子的那一句。']);
});

test('Adrian can choose to leave a signed note or simply talk, and a future wake can reuse the same dated store', async t => {
  const date = '2026-11-28', kept = '两片新叶冒出来了，我也想记住今天的窗台。';
  let store, calls = 0;
  const routes = createLiveRoutes({ baseURL: 'https://fixture.example/v1', model, apiKey: 'fixture-key',
    personalMemory: { listTools: () => [], surface: () => null },
    readCalendar: (args, day, route) => store.calendar.read(args, day, route),
    fetchImpl: async (_, opts) => {
      calls++;
      const {messages} = JSON.parse(opts.body);
      const last = messages.at(-1);
      if (last.role === 'tool') return stream({content: '两片新叶，真好。'});
      if (last.content.includes('薄荷')) return stream({tool_calls:[{id:'write-a-note',type:'function',function:{
        name:'calendar_note',arguments:JSON.stringify({date,text:kept})}}]}, 'tool_calls');
      return stream({content:'我在。'});
    } });
  store = openStore(':memory:', {complete: routes.complete, models: routes.active('mock').models,
    modelsForRoute: id => routes.active(id).models, resumePendingOnRead:false, enableCalendar:true, embedder:false});
  t.after(() => store.close());
  routes.select(store,{route:'gemini',model});
  routes.setMemorySource(store,{route:'gemini',source:'personal'});
  await store.send({requestId:'hello',text:'晚上好。'});
  assert.deepEqual(store.calendar.notes(date,'gemini'),[]);
  const shared = {requestId:'mint',text:'今天窗台的薄荷冒了两片新叶。'};
  const reply = await store.send(shared);
  assert.equal(reply.messages[1].meta.memoryTool.name,'calendar_note');
  assert.equal(reply.messages[1].meta.memoryTool.output,kept);
  const before = calls;
  await store.send(shared);
  assert.equal(calls,before);
  assert.deepEqual(store.calendar.month('2026-11','gemini').marks[date],{note:true});
  assert.deepEqual(store.calendar.stars(date,'gemini'),[]);
  assert.deepEqual(store.calendar.read({date,category:'notes'},null,'gemini').evidence.records,[kept]);
  assert.deepEqual(store.calendar.read({date,category:'notes'},null,'other').evidence.records,[]);
  const source = {route:'gemini',operation:'wake:synthetic-example'};
  const note = {date,text:'另外一次醒来时留下的小字。'};
  const saved = store.calendar.note(note,source);
  assert.deepEqual(store.calendar.note(note,source),saved);
  assert.equal(store.calendar.notes(date,'gemini').length,2);
});
