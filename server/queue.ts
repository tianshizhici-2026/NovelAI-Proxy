import type { GenerationQueueStatus, GenerationJobStatus } from '../shared/types.js';
import { ApiError } from './policy.js';

type Job = { id: string; username: string; start: (release: () => void) => void; reject: (error: Error) => void };

export class GenerationQueue {
  private active?: Job;
  private waiting: Job[] = [];
  readonly capacity = 5;

  status(): GenerationQueueStatus { return { generating: !!this.active, waiting: this.waiting.length, capacity: this.capacity }; }
  hasJobs(username: string) { return this.active?.username === username || this.waiting.some(job => job.username === username); }
  job(id: string, username: string): GenerationJobStatus | undefined {
    if (this.active?.id === id && this.active.username === username) return { ...this.status(), state: 'running', position: 0 };
    const position = this.waiting.findIndex(job => job.id === id && job.username === username);
    return position < 0 ? undefined : { ...this.status(), state: 'waiting', position: position + 1 };
  }
  acquire(id: string, username: string): Promise<() => void> {
    if (this.active?.id === id || this.waiting.some(job => job.id === id))
      throw new ApiError(409, '此任务已提交，请等待生成结果。', 'DUPLICATE_JOB');
    if (this.active && this.waiting.length >= this.capacity)
      throw new ApiError(409, '已有生成任务正在处理，等待队列已满（5 张），请稍后再试。', 'BUSY');
    return new Promise((start, reject) => {
      const job: Job = { id, username, start, reject };
      if (this.active) this.waiting.push(job);
      else this.start(job);
    });
  }
  private start(job: Job) {
    this.active = job;
    job.start(() => {
      if (this.active !== job) return;
      this.active = undefined;
      const next = this.waiting.shift();
      if (next) this.start(next);
    });
  }
  cancel(id: string, username: string) {
    const index = this.waiting.findIndex(job => job.id === id && job.username === username);
    if (index < 0) return false;
    const [job] = this.waiting.splice(index, 1);
    job.reject(new ApiError(499, '排队请求已取消。', 'QUEUE_CANCELLED'));
    return true;
  }
}
