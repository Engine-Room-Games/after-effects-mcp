/**
 * Build an MCP tool result with both a metadata text block and an inline image.
 */
export function imageContent(meta: Record<string, unknown>, base64: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(meta) },
      { type: "image" as const, data: base64, mimeType: "image/png" },
    ],
  };
}
