// Swaps '@upstash/redis' for an in-memory store so api/*.js can be imported
// and exercised without Upstash. Used by `npm test`:
//   node --import ./test/mock-redis.mjs --test "test/**/*.test.mjs"
import { registerHooks } from 'node:module';

const MOCK = new URL('./mock-redis-impl.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@upstash/redis') return { url: MOCK, shortCircuit: true };
    return next(specifier, context);
  },
});
