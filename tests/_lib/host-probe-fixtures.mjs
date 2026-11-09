// Synthetic host-log fixture parser shared by the unit contract and opt-in real-host e2e.
export function kiroLoadedEvent(text) {
  for (const line of text.split("\n")) {
    try {
      const message = JSON.parse(line).message;
      if (typeof message !== "string" || !message.startsWith("hooks.reload.loaded ")) continue;
      const event = JSON.parse(message.slice("hooks.reload.loaded ".length));
      if (Number.isInteger(event.read) && event.read >= 0 && Number.isInteger(event.registered) && event.registered >= 0) return event;
    } catch { /* An unrelated or incomplete log line is not a loader acknowledgement. */ }
  }
  return undefined;
}
