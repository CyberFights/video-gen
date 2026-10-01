#!/usr/bin/env node
/**
 * Renderer connectivity diagnostics.
 *
 * Run it inside the app service (`railway ssh` / `railway run npm run doctor`)
 * to see, in order: what the app resolved from the environment, whether the
 * renderer hostname resolves, whether each resolved address accepts a TCP
 * connection on the renderer port, and what `/health` returns.
 *
 * Exits non-zero when the renderer is not reachable, so it can gate a deploy.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { rendererConfig } from "./video.js";

const TCP_TIMEOUT_MS = Number.parseInt(process.env.PYTHON_API_HEALTH_TIMEOUT_MS || "5000", 10);

const check = text => `  [ok]   ${text}`;
const warn = text => `  [warn] ${text}`;
const fail = text => `  [fail] ${text}`;

function section(title) {
  console.log(`\n${title}`);
}

async function resolveHost(hostname) {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  try {
    return await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    return { error: error.code || error.message };
  }
}

function tcpProbe(address, port, family) {
  return new Promise(resolve => {
    const socket = net.connect({ host: address, port: Number(port), family });
    const done = result => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, code: "ETIMEDOUT" }));
    socket.once("error", error => done({ ok: false, code: error.code || error.message }));
  });
}

async function main() {
  const config = rendererConfig();

  section("Configuration");
  console.log(`  PYTHON_API_URL  = ${process.env.PYTHON_API_URL ?? "(unset)"}`);
  console.log(`  PYTHON_API_HOST = ${process.env.PYTHON_API_HOST ?? "(unset)"}`);
  console.log(`  PYTHON_API_PORT = ${process.env.PYTHON_API_PORT ?? "(unset, default 8000)"}`);
  console.log(`  resolved target = ${config.url} (source: ${config.source})`);
  if (process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_PRIVATE_DOMAIN) {
    console.log(`  this service    = ${process.env.RAILWAY_SERVICE_NAME ?? "?"} (${process.env.RAILWAY_PRIVATE_DOMAIN ?? "no private domain"})`);
  }

  let healthy = true;

  if (!config.configured) {
    console.log(warn("No renderer configured; using the local-development fallback 127.0.0.1:8000."));
  }
  if (config.selfReference) {
    healthy = false;
    console.log(fail(`${config.hostname} is this service's own private domain. Point PYTHON_API_HOST at the renderer service instead: \${{renderer.RAILWAY_PRIVATE_DOMAIN}}.`));
  }
  if (config.expectedPrivateHostname) {
    healthy = false;
    console.log(fail(
      `PYTHON_API_HOST is ${config.hostname}, but Railway private hostnames are exactly ` +
      "`<service-name>.railway.internal` — the project name is not part of the hostname — " +
      `so that name can never resolve. A service named ` +
      `"${config.expectedPrivateHostname.split(".")[0]}" lives at ${config.expectedPrivateHostname} instead.`
    ));
  }
  if (config.privateNetwork && !config.selfReference) {
    console.log(check(`Target uses Railway private networking (${config.hostname}).`));
  }

  section(`DNS (${config.hostname})`);
  const addresses = await resolveHost(config.hostname);
  if (addresses.error) {
    healthy = false;
    console.log(fail(`Lookup failed: ${addresses.error}. The renderer must be deployed in the same project and environment.`));
    if (config.expectedPrivateHostname) {
      const candidate = await resolveHost(config.expectedPrivateHostname);
      if (candidate.error) {
        console.log(fail(
          `${config.expectedPrivateHostname} did not resolve either. If the renderer service is really ` +
          `named "${config.expectedPrivateHostname.split(".")[0]}", it is not deployed (or not running) in ` +
          "this environment — check its deploy logs. Otherwise the hostname is simply wrong."
        ));
      } else {
        console.log(check(`The corrected form ${config.expectedPrivateHostname} DOES resolve:`));
        for (const entry of candidate) {
          console.log(check(`  IPv${entry.family} ${entry.address}`));
        }
        let confirmed = false;
        for (const entry of candidate) {
          const result = await tcpProbe(entry.address, config.port, entry.family);
          if (result.ok) {
            confirmed = true;
            console.log(check(`${entry.address}:${config.port} accepted a connection — the renderer answers there.`));
          } else {
            console.log(fail(`${entry.address}:${config.port}: ${result.code}`));
          }
        }
        try {
          const response = await fetch(`http://${config.expectedPrivateHostname}:${config.port}/health`, { signal: AbortSignal.timeout(TCP_TIMEOUT_MS) });
          const body = await response.text();
          if (response.ok) {
            confirmed = true;
            console.log(check(`GET /health via ${config.expectedPrivateHostname} → ${response.status} ${body.slice(0, 120)}`));
          } else {
            console.log(fail(`GET /health via ${config.expectedPrivateHostname} → ${response.status} ${body.slice(0, 120)}`));
          }
        } catch (error) {
          console.log(fail(`GET /health via ${config.expectedPrivateHostname} failed: ${error.cause?.code || error.code || error.message}`));
        }
        if (confirmed) {
          console.log(check(
            `The renderer's private domain is ${config.expectedPrivateHostname}. Fix: ` +
            `PYTHON_API_HOST=\${{renderer.RAILWAY_PRIVATE_DOMAIN}} (or ${config.expectedPrivateHostname}), then redeploy.`
          ));
        }
      }
    }
  } else {
    for (const entry of addresses) {
      console.log(check(`IPv${entry.family} ${entry.address}`));
    }
    if (config.privateNetwork && !addresses.some(entry => entry.family === 6)) {
      console.log(warn("No AAAA record. Legacy Railway environments are IPv6-only on the private network."));
    }
  }

  section(`TCP connect (port ${config.port})`);
  if (addresses.error) {
    console.log(warn("Skipped: hostname did not resolve."));
  } else {
    let anyOpen = false;
    for (const entry of addresses) {
      const result = await tcpProbe(entry.address, config.port, entry.family);
      if (result.ok) {
        anyOpen = true;
        console.log(check(`${entry.address} accepted the connection.`));
      } else if (result.code === "ECONNREFUSED") {
        console.log(fail(`${entry.address} refused the connection. Nothing is listening on port ${config.port} there — wrong service, or the renderer is not bound to that address family.`));
      } else {
        console.log(fail(`${entry.address}: ${result.code}`));
      }
    }
    if (!anyOpen) {
      healthy = false;
      if (addresses.some(entry => entry.family === 6) && config.privateNetwork) {
        console.log(warn("If the renderer logs \"Uvicorn running on http://0.0.0.0\", it is IPv4-only. Start it with python serve.py so it binds :: (IPv6 + IPv4)."));
      }
    }
  }

  section("GET /health");
  try {
    const response = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(TCP_TIMEOUT_MS) });
    const body = await response.text();
    if (response.ok) {
      console.log(check(`${response.status} ${body.slice(0, 200)}`));
    } else {
      healthy = false;
      console.log(fail(`${response.status} ${body.slice(0, 200)}`));
    }
  } catch (error) {
    healthy = false;
    const code = error.cause?.code || error.code || error.message;
    console.log(fail(`Request failed: ${code}`));
  }

  console.log(`\n${healthy ? "Renderer reachable." : "Renderer NOT reachable. See README \"Troubleshooting\"."}`);
  return healthy ? 0 : 1;
}

main().then(code => process.exit(code), error => {
  console.error(error);
  process.exit(1);
});
