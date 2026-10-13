/** Transport errors may contain signed artifact URLs. Keep destinations, never credentials. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
    } catch {
      return "[redacted URL]";
    }
  });
}
