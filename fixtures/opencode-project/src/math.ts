/**
 * Math helpers for the PHASE 10 smoke fixture.
 *
 * NOTE: two functions contain deliberate bugs that the smoke scenarios
 * are expected to find and fix — do not repair them in the fixture.
 */

/** Returns n! for n >= 0. BUG: the result accumulator starts at 0. */
export function factorial(n: number): number {
  if (n < 0) throw new Error("n must be >= 0");
  let result = 0; // <-- bug: should start at 1
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

/** nth Fibonacci number for n >= 0. Correct implementation. */
export function fibonacci(n: number): number {
  if (n < 0) throw new Error("n must be >= 0");
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

/** Whether n is even. BUG: the remainder check is inverted. */
export function isEven(n: number): boolean {
  return n % 2 === 1; // <-- bug: should be n % 2 === 0
}