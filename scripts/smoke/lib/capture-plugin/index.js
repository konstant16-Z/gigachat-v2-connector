// Capture plugin for the smoke harness: registered AFTER the connector in the
// plugins array so its http hooks observe the FINAL rewritten request and the
// upstream response. Writes the outbound URL + body + response status to
// $SMOKE_DUMP_LOG (env) — hard evidence that traffic flowed through the
// connector's V2 pipeline to the live API.
//
// Fields are appended (never reordered) so the §26 smoke greps keep working:
//   REQ  ... model=<m> fstate=<yes|no> tools=<n> msgs=<n>
//   RESP ... bytes=<n> ctype=<type> sse=<yes|no> reasoning=<yes|no> usage=<yes|no>
// The extra fields are the §27 long-session evidence (state round-trip, wire
// size/context growth, streaming, reasoning and usage surfacing).
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
        const parsed = (() => {
          try {
            return JSON.parse(body) ?? {};
          } catch {
            return {};
          }
        })();
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const toolSpecs = Array.isArray(parsed.tools)
          ? parsed.tools.reduce((n, t) => {
              const specs = t?.functions?.specifications;
              return n + (Array.isArray(specs) ? specs.length : 0);
            }, 0)
          : 0;
        const hasState = /"(functions_state_id|tool_state_id)"\s*:/.test(body);
        appendFileSync(
          LOG,
          `${new Date().toISOString()} REQ url=${req?.url ?? "?"} method=${req?.method ?? "?"} ` +
            `bytes=${body.length} ` +
            `rquid=${req?.headers?.get("RqUID") ?? "?"} ` +
            `auth=${(req?.headers?.get("Authorization") ?? "none").slice(0, 7)} ` +
            `model=${parsed.model ?? "?"} ` +
            `fstate=${hasState ? "yes" : "no"} tools=${toolSpecs} msgs=${messages.length}\n`,
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
        const ctype = resp?.headers?.get("Content-Type") ?? "?";
        const sse = ctype.includes("text/event-stream");
        appendFileSync(
          LOG,
          `${new Date().toISOString()} RESP url=${event?.request?.url ?? "?"} status=${resp?.status ?? "?"} ` +
            `bytes=${text.length} ctype=${ctype} sse=${sse ? "yes" : "no"} ` +
            `reasoning=${text.includes("reasoning_content") ? "yes" : "no"} ` +
            `usage=${/"usage"\s*:/.test(text) ? "yes" : "no"}\n`,
        );
      } catch (err) {
        appendFileSync(LOG, `${new Date().toISOString()} RESP error=${String(err)}\n`);
      }
    });
  },
};

export default plugin;
