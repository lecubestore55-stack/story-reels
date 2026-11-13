// Runs the web app and the worker in ONE container (used on Railway and other clouds).
// If either process dies, the other is stopped and the container exits so the platform restarts it.
import { spawn } from "node:child_process";

const port = process.env.PORT || "3000";
const node = process.execPath;
const procs = [
  spawn(node, ["node_modules/next/dist/bin/next", "start", "-p", port, "-H", "0.0.0.0"], { stdio: "inherit" }),
  spawn(node, ["--import", "tsx", "worker/index.ts"], { stdio: "inherit" }),
];

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
  // Give the worker time to finish writing; unfinished fal requests are resumed after restart.
  const timer = setTimeout(() => process.exit(code), 15000);
  Promise.all(procs.map((p) => (p.exitCode !== null ? null : new Promise((r) => p.on("exit", r))))).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}
for (const p of procs) p.on("exit", (code) => shutdown(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(0));
