export const qwenTokenCap = (text: string) => Math.ceil((3 + 0.2 * text.length) * 12.5);
