// Capture plugin for the smoke harness: registered AFTER the connector in the
// plugins array so its http hooks observe the FINAL rewritten request and the
// upstream response. Writes the outbound URL + body + response status to
// $SMOKE_DUMP_LOG (env) — hard evidence that traffic flowed through the
// connector's V2 pipeline to the live API.
import { appendFileSync } from "node:fs";

const LOG = process.env.SMOKE_DUMP_LOG ?? "/tmp/opencode/smoke-dump.log";

const plugin = {
  id: "smoke-capture",
  async setup(ctx) {
    const session = ctx?.session;
    await session.hook("http.request", async (event) => {
      try {
        const req = event?.request;
        let body = "";
        try {
          body = await req.clone().text();
        } catch (err) {
          body = `ERR ${String(err)}`;
        }
        appendFileSync(
          LOG,
          `${new Date().toISOString()} REQ url=${req?.url ?? "?"} method=${req?.method ?? "?"} ` +
            `bytes=${body.length} ` +
            `rquid=${req?.headers?.get("RqUID") ?? "?"} ` +
            `auth=${(req?.headers?.get("Authorization") ?? "none").slice(0, 7)} ` +
            `model=${(() => {
              try {
                return JSON.parse(body)?.model ?? "?";
              } catch {
                return "?";
              }
            })()}\n`,
        );
      } catch (err) {
        appendFileSync(LOG, `${new Date().toISOString()} REQ error=${String(err)}\n`);
      }
    });
    await session.hook("http.response", async (event) => {
      try {
        const resp = event?.response;
        let text = "";
        try {
          text = await resp.clone().text();
        } catch (err) {
          text = `ERR ${String(err)}`;
        }
        appendFileSync(
          LOG,
          `${new Date().toISOString()} RESP url=${event?.request?.url ?? "?"} status=${resp?.status ?? "?"} bytes=${text.length}\n`,
        );
      } catch (err) {
        appendFileSync(LOG, `${new Date().toISOString()} RESP error=${String(err)}\n`);
      }
    });
  },
};

export default plugin;