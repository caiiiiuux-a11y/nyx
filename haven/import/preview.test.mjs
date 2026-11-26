import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function node(id, parent, role, text, children = []) {
  return { id, parent, children, message: {
    id: 'message-' + id, author: { role }, content: { content_type: 'text', parts: [text] }
  } };
}

test('a changed message is flagged while both reply branches remain available without exposing text', async t => {
  const original = {
    id: 'thread', title: 'private-title-canary', current_node: 'old',
    mapping: {
      prompt: node('prompt', null, 'user', 'private-prompt-canary', ['old']),
      old: node('old', 'prompt', 'assistant', 'private-answer-canary')
    }
  };
  const revised = structuredClone(original);
  revised.mapping.prompt.message.content.parts = ['private-edited-canary'];
  revised.mapping.prompt.children.push('retry');
  revised.mapping.retry = node('retry', 'prompt', 'assistant', 'private-retry-canary');
  revised.current_node = 'retry';

  const root = await mkdtemp(join(tmpdir(), 'haven-import-test-'));
  const directories = [join(root, 'first'), join(root, 'next')];
  t.after(async () => {
    for (const directory of directories) {
      await unlink(join(directory, 'conversations-000.json'));
      await rmdir(directory);
    }
    await rmdir(root);
  });
  for (const [i, batch] of [original, revised].entries()) {
    await mkdir(directories[i]);
    await writeFile(join(directories[i], 'conversations-000.json'), JSON.stringify([batch]));
  }
  const cli = fileURLToPath(new URL('preview.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...directories], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /private-\w+-canary/);
  const { batches, comparison } = JSON.parse(result.stdout);
  assert.deepEqual(comparison.conflicts, [{ conversationId: 'thread', nodeId: 'prompt', kind: 'changed_or_ambiguous_node' }]);
  assert.deepEqual(comparison.appended, [{ conversationId: 'thread', nodeIds: ['retry'] }]);
  assert.deepEqual(comparison.duplicates, [{ conversationId: 'thread', nodeIds: ['old'] }]);
  const turn = batches[1].conversations[0];
  assert.deepEqual(turn.activeNodeIds, ['retry']);
  const source = Object.fromEntries(turn.nodes.map(n => [n.id, n]));
  assert.deepEqual(source.prompt.children, ['old', 'retry']);
  assert.equal(source.old.parent, 'prompt');
  assert.equal(source.retry.parent, 'prompt');
});
