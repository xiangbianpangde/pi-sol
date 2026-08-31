// Helper for cross-process admission tests. Usage:
//   node flock-child.mjs <stateDir> <jobsDir> <mode>
//   mode=hold : acquire a lease, print ACQUIRED:<path>, then wait HOLD_MS and exit
//   mode=probe: try to acquire; print BUSY or ACQUIRED/RELEASED
import { acquireSolSubmitLease, releaseSolSubmitLease } from "../lib/sol/admission.ts";
const [stateDir, jobsDir, mode] = process.argv.slice(2);
const holdMs = Number(process.env.HOLD_MS ?? 3000);

const result = await acquireSolSubmitLease(stateDir, jobsDir, 2);
if (!result.acquired) {
  process.stdout.write("BUSY\n");
  process.exit(0);
}
process.stdout.write("ACQUIRED:" + result.lease.path + "\n");
if (mode === "hold") {
  await new Promise((r) => setTimeout(r, holdMs));
}
await releaseSolSubmitLease(result.lease);
process.stdout.write("RELEASED\n");
