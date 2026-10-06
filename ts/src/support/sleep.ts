const cell = new Int32Array(new SharedArrayBuffer(4));

/** Block the thread for `ms` milliseconds, like Python's `time.sleep`. Use it only in short retry loops. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(cell, 0, 0, ms);
}
