/**
 * Greets a user by name. Small module used by the PHASE 10 smoke fixture.
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function main(): void {
  console.log(greet("OpenCode"));
}

if (import.meta.main) main();