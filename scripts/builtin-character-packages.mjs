import { fileURLToPath } from "node:url";
import { syncPackageIndex } from "./package-tools.mjs";
const command = process.argv[2];
if (!["sync", "check"].includes(command)) throw new Error("Usage: builtin-character-packages.mjs <sync|check>");
const changed = await syncPackageIndex(fileURLToPath(new URL("../public/characters", import.meta.url)), { check: command === "check" });
if (command === "check" && changed) process.exitCode = 1;
