import { runHttpServer, runStdio } from "./server.js";

const mode = process.argv[2] ?? "stdio";

if (mode === "sse" || mode === "http") {
  await runHttpServer();
} else {
  await runStdio();
}
