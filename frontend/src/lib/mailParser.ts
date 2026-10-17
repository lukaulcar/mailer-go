export interface ParsedMailContent {
  text: string;
  html?: string;
}

export function decodeQuotedPrintable(input: string): string {
  if (!input) return "";

  let clean = input.replace(/=\r?\n/g, "");

  try {
    const percentEncoded = clean.replace(/=([A-Fa-f0-9]{2})/g, "%$1");
    return decodeURIComponent(percentEncoded);
  } catch {
    return clean.replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return `=${hex}`;
      }
    });
  }
}

export function isRawMultipart(body: string): boolean {
  if (!body) return false;
  const trimmed = body.trim();
  return (
    trimmed.startsWith("--") &&
    (trimmed.includes("Content-Type:") || trimmed.includes("content-type:"))
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseMultipartBody(rawBody: string): ParsedMailContent {
  const trimmed = rawBody.trim();
  if (!isRawMultipart(trimmed)) {
    return { text: trimmed };
  }

  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const boundary = firstLine.replace(/^--/, "").replace(/--$/, "").trim();

  if (!boundary || boundary.length > 200) {
    return { text: trimmed };
  }

  const parts = trimmed.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`));
  let text = "";
  let html = "";

  for (const part of parts) {
    const trimmedPart = part.trim();
    if (!trimmedPart) continue;

    const headerEndIndex = trimmedPart.search(/\r?\n\r?\n/);
    if (headerEndIndex === -1) continue;

    const rawHeaders = trimmedPart.slice(0, headerEndIndex);
    const rawContent = trimmedPart.slice(headerEndIndex).replace(/^\r?\n\r?\n/, "");

    const isHTML = /Content-Type:\s*text\/html/i.test(rawHeaders);
    const isPlain = /Content-Type:\s*text\/plain/i.test(rawHeaders);
    const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(rawHeaders);
    const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(rawHeaders);

    let decoded = rawContent;
    if (isQP) {
      decoded = decodeQuotedPrintable(rawContent);
    } else if (isBase64) {
      try {
        decoded = atob(rawContent.replace(/\s+/g, ""));
      } catch {
        decoded = rawContent;
      }
    }

    if (isHTML && !html) {
      html = decoded.trim();
    } else if (isPlain && !text) {
      text = decoded.trim();
    }
  }

  return {
    text: text || (html ? stripHtml(html) : trimmed),
    html: html || undefined,
  };
}

export function stripHtml(htmlStr: string): string {
  if (!htmlStr) return "";
  return htmlStr
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function getCleanMessageContent(message: { body: string; body_html?: string }): ParsedMailContent {
  let html = message.body_html?.trim() || undefined;
  let text = message.body;

  if (isRawMultipart(message.body)) {
    const parsed = parseMultipartBody(message.body);
    text = parsed.text;
    if (!html && parsed.html) {
      html = parsed.html;
    }
  } else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(text)) {
    text = decodeQuotedPrintable(text);
  }

  return { text, html };
}
