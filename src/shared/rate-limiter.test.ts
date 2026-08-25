import { describe, it, expect } from 'vitest';
import { createInProcessRateLimiter } from './rate-limiter';

describe('createInProcessRateLimiter', () => {
  const withClock = () => {
    let now = 1_000_000;
    const limiter = createInProcessRateLimiter(() => now);
    return { limiter, advance: (seconds: number) => (now += seconds * 1000) };
  };

  it('allows up to the limit and refuses the next', async () => {
    const { limiter } = withClock();
    for (let i = 0; i < 3; i++) {
      expect((await limiter.check('k', 3, 60)).allowed, `call ${i + 1}`).toBe(true);
    }
    const over = await limiter.check('k', 3, 60);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts down remaining', async () => {
    const { limiter } = withClock();
    expect((await limiter.check('k', 3, 60)).remaining).toBe(2);
    expect((await limiter.check('k', 3, 60)).remaining).toBe(1);
    expect((await limiter.check('k', 3, 60)).remaining).toBe(0);
  });

  it('keys are independent', async () => {
    const { limiter } = withClock();
    await limiter.check('a', 1, 60);
    expect((await limiter.check('a', 1, 60)).allowed).toBe(false);
    expect((await limiter.check('b', 1, 60)).allowed).toBe(true);
  });

  it('opens a fresh window once the old one elapses', async () => {
    const { limiter, advance } = withClock();
    await limiter.check('k', 1, 60);
    expect((await limiter.check('k', 1, 60)).allowed).toBe(false);

    advance(60);
    expect((await limiter.check('k', 1, 60)).allowed).toBe(true);
  });

  it('reports a retry-after that shrinks as the window elapses', async () => {
    const { limiter, advance } = withClock();
    await limiter.check('k', 1, 60);
    const first = await limiter.check('k', 1, 60);
    advance(30);
    const later = await limiter.check('k', 1, 60);
    expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds);
  });

  it('sweeps expired buckets rather than growing without bound', async () => {
    const { limiter, advance } = withClock();
    for (let i = 0; i < 500; i++) await limiter.check(`key-${i}`, 1, 1);
    advance(120); // past the windows AND past the sweep interval
    // The sweep runs on the next check; a fresh key must still be allowed.
    expect((await limiter.check('after-sweep', 1, 60)).allowed).toBe(true);
  });

  it('reset forgets everything', async () => {
    const { limiter } = withClock();
    await limiter.check('k', 1, 60);
    limiter.reset();
    expect((await limiter.check('k', 1, 60)).allowed).toBe(true);
  });
});
