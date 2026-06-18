#!/usr/bin/env node
// Back-compat shim: the facilitator is now the `facilitator` ROLE of the generalized
// room-agent daemon (agent.mjs). This entrypoint is preserved so existing commands
// (and docs) keep working — it just runs agent.mjs with --role facilitator and the
// historical --state default (./.qos-facilitator). For other roles, or to run several
// agents in one room, use `node agent.mjs --role <role>` directly. See README.

import { run, parseArgs } from "./agent.mjs";

const a = parseArgs(process.argv.slice(2));
if (!a.role) a.role = "facilitator";
if (!a.state) a.state = "./.qos-facilitator";   // preserve the historical state dir
run(a).catch((e) => { console.error(e); process.exit(1); });
