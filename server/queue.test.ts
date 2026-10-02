import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationQueue } from './queue.js';

test('one running job and five waiting jobs are accepted; overflow is rejected; FIFO advances one at a time', async () => {
  const queue = new GenerationQueue();
  let release = await queue.acquire('active', 'admin');
  const starts: number[] = [];
  const promises = Array.from({ length: 5 }, (_, index) => queue.acquire(`job-${index}`, 'user').then(finish => { starts.push(index); return finish; }));
  assert.deepEqual(queue.status(), { generating: true, waiting: 5, capacity: 5 });
  assert.throws(() => queue.acquire('overflow', 'other'), (error: any) => error.status === 409 && error.code === 'BUSY');
  for (let index = 0; index < 5; index++) {
    assert.equal(queue.job(`job-${index}`, 'user')?.position, index + 1);
  }
  assert.equal(queue.job('job-0', 'other'), undefined);
  assert.deepEqual(starts, []);
  for (let index = 0; index < 5; index++) {
    release();
    release = await promises[index];
    assert.deepEqual(starts, Array.from({ length: index + 1 }, (_, n) => n));
    assert.equal(queue.job(`job-${index}`, 'user')?.state, 'running');
    assert.equal(queue.status().waiting, 4 - index);
  }
  release(); release();
  assert.deepEqual(queue.status(), { generating: false, waiting: 0, capacity: 5 });
});

test('cancelling a waiting job removes it without consuming a running slot and updates positions', async () => {
  const queue = new GenerationQueue();
  const release = await queue.acquire('active', 'admin');
  const cancelled = queue.acquire('cancelled', 'user');
  const rejected = assert.rejects(cancelled, (error: any) => error.code === 'QUEUE_CANCELLED');
  const next = queue.acquire('next', 'other');
  assert.equal(queue.cancel('cancelled', 'other'), false);
  assert.equal(queue.cancel('active', 'admin'), false);
  assert.equal(queue.cancel('cancelled', 'user'), true);
  await rejected;
  assert.equal(queue.job('next', 'other')?.position, 1);
  assert.equal(queue.status().waiting, 1);
  release(); (await next)();
  assert.equal(queue.status().generating, false);
});

test('duplicate task IDs cannot execute twice while a task is running or queued', async () => {
  const queue = new GenerationQueue();
  const release = await queue.acquire('active', 'admin');
  const next = queue.acquire('next', 'user');
  assert.throws(() => queue.acquire('active', 'admin'), (error: any) => error.code === 'DUPLICATE_JOB');
  assert.throws(() => queue.acquire('next', 'user'), (error: any) => error.code === 'DUPLICATE_JOB');
  release(); (await next)();
});
