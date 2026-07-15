// Typed API client. Wave 1 only knows about the two human-gate commands
// declared in @tk/contracts (StartAutomationV1 is the only one the Workbench
// UI dispatches). Wave 2 will plug real HTTP/fetch transport in here; for now
// every method just validates against the zod schema and routes through the
// injected send() transport.

import { StartAutomationV1, type StartAutomationV1 as StartAutomationV1T } from "@tk/contracts/commands";

export type ApiClient = Readonly<{
  send: (command: string, payload: unknown) => { accepted: boolean };
}>;

export function dispatchStartAutomation(
  client: ApiClient,
  input: Omit<StartAutomationV1T, "version">
): { accepted: boolean } {
  const payload: StartAutomationV1T = { version: 1, ...input };
  const parsed = StartAutomationV1.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `StartAutomationV1 payload rejected: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }
  return client.send("StartAutomationV1", parsed.data);
}