/** Lightweight, dependency-free token estimator used only when upstream usage is missing. */
export function estimateTextTokens(text) {
  if (text === undefined || text === null) return 0;
  const s = String(text);
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    } else if (code < 128) {
      ascii++;
    } else {
      other++;
    }
  }
  // CJK ≈ 1.1 tokens/char; Latin ≈ 4 chars/token; symbols/emoji ≈ 1 token each.
  return Math.ceil(cjk * 1.1 + ascii / 4 + other * 1.2);
}

function contentTokens(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') total += estimateTextTokens(part.text);
      else if (part.type === 'image_url') {
        const detail = part.image_url?.detail;
        total += detail === 'low' ? 85 : 500;
      } else if (part.type === 'input_audio') total += 200;
      else total += estimateTextTokens(JSON.stringify(part));
    }
    return total;
  }
  return estimateTextTokens(JSON.stringify(content));
}

export function estimateChatPromptTokens(messages, tools) {
  if (!Array.isArray(messages)) return 0;
  let total = 2;
  for (const msg of messages) {
    if (!msg) continue;
    total += 4;
    total += estimateTextTokens(msg.role || '');
    total += contentTokens(msg.content);
    if (msg.name) total += estimateTextTokens(msg.name) + 1;
    if (msg.tool_calls) total += estimateTextTokens(JSON.stringify(msg.tool_calls));
    if (msg.function_call) total += estimateTextTokens(JSON.stringify(msg.function_call));
    if (msg.reasoning_content) total += estimateTextTokens(msg.reasoning_content);
  }
  if (tools) total += estimateTextTokens(JSON.stringify(tools));
  return Math.max(1, total);
}

export function estimateCompletionTokens(value) {
  if (!value) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => {
      if (!item) return sum;
      if (typeof item === 'string') return sum + estimateTextTokens(item);
      if (item.message) return sum + estimateTextTokens(item.message.content || '') + estimateTextTokens(JSON.stringify(item.message.tool_calls || ''));
      if (item.text) return sum + estimateTextTokens(item.text);
      return sum + estimateTextTokens(item.content || JSON.stringify(item));
    }, 0);
  }
  return estimateTextTokens(JSON.stringify(value));
}

/** Incremental estimator that does not retain generated text. */
export class OutputMeter {
  constructor() {
    this.cjk = 0;
    this.ascii = 0;
    this.other = 0;
    this.chars = 0;
  }

  add(text) {
    if (!text) return;
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      this.chars++;
      if (code >= 0x4e00 && code <= 0x9fff) this.cjk++;
      else if (code < 128) this.ascii++;
      else this.other++;
    }
  }

  get tokens() {
    return Math.ceil(this.cjk * 1.1 + this.ascii / 4 + this.other * 1.2);
  }
}
