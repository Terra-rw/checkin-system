// Runs every end-to-end test file. Usage: npm test   (from server/ or the project root)
// Each file starts its own server on a temporary database; nothing real is touched.
const files = ['schedule.test.mjs', 'api.test.mjs', 'contracts.test.mjs', 'migration.test.mjs', 'tenant-isolation.test.mjs'];
const only = process.argv[2];

let failures = 0;
for (const f of files.filter((x) => !only || x.includes(only))) {
  const mod = await import(new URL(`./${f}`, import.meta.url));
  failures += await mod.run();
}
console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll test files passed.');
process.exit(failures ? 1 : 0);
