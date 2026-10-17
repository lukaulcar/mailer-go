export type TemplateBlockType =
  | "header"
  | "hero"
  | "text"
  | "button"
  | "otp"
  | "callout"
  | "keyvalue"
  | "divider"
  | "footer";

export const FONT_OPTIONS: { value: string; label: string; stack: string }[] = [
  { value: "sans", label: "Modern Sans (Inter / System)", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { value: "arial", label: "Arial / Helvetica", stack: 'Arial, Helvetica, sans-serif' },
  { value: "verdana", label: "Verdana (wide, readable)", stack: 'Verdana, Geneva, sans-serif' },
  { value: "tahoma", label: "Tahoma / Segoe UI", stack: 'Tahoma, "Segoe UI", Geneva, sans-serif' },
  { value: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", Verdana, sans-serif' },
  { value: "georgia", label: "Georgia (elegant serif)", stack: 'Georgia, "Times New Roman", serif' },
  { value: "times", label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  { value: "palatino", label: "Palatino / Book Antiqua", stack: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
  { value: "courier", label: "Courier New (mono)", stack: '"Courier New", Courier, monospace' },
  { value: "mono", label: "Clean Mono (code)", stack: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", monospace' },
  { value: "serif", label: "Classic Serif", stack: 'Georgia, Cambria, "Times New Roman", Times, serif' },
];

export function resolveFontStack(nameOrStack: string | undefined): string {
  if (!nameOrStack) return FONT_OPTIONS[0].stack;
  const found = FONT_OPTIONS.find((f) => f.value === nameOrStack);
  if (found) return found.stack;
  
  if (nameOrStack.includes(",") || nameOrStack.includes('"') || nameOrStack.includes("'")) return nameOrStack;
  return FONT_OPTIONS[0].stack;
}


export function escapeHtml(s: string | undefined | null): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


export function escapeAttr(s: string | undefined | null): string {
  return escapeHtml(s).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}


export function sanitizeUrl(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "#";
  if (s.includes("{{") && s.includes("}}")) return s.replace(/"/g, "%22");
  const lower = s.toLowerCase();
  if (
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    s.startsWith("#") ||
    s.startsWith("/")
  ) {
    return s;
  }
  return "#";
}


export function sanitizeColor(raw: string | undefined | null, fallback: string): string {
  const s = (raw ?? "").trim();
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return s;
  return fallback;
}


export function sanitizeFontStack(raw: string | undefined | null, fallback: string): string {
  const s = (raw ?? "").trim();
  if (!s || /[<>"';\\]/.test(s)) return fallback;
  return s;
}

export interface TemplateTheme {
  primaryColor: string;
  bgColor: string;
  cardBgColor: string;
  textColor: string;
  fontFamily: string;
  headingFontFamily?: string;
  borderRadius: "sharp" | "rounded" | "curved";
  maxWidth: number;
  contentPadding?: number;
}

export interface HeaderBlock {
  type: "header";
  id: string;
  brandName: string;
  logoUrl?: string;
  logoHeight?: number;
  badgeText?: string;
  align: "left" | "center";
  fontFamily?: string;
}

export interface HeroBlock {
  type: "hero";
  id: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  align: "left" | "center";
  titleSize?: "sm" | "md" | "lg" | "xl";
  fontFamily?: string;
}

export interface TextBlock {
  type: "text";
  id: string;
  content: string;
  fontSize: "sm" | "base" | "lg";
  align?: "left" | "center" | "right";
  fontFamily?: string;
}

export interface ButtonBlock {
  type: "button";
  id: string;
  text: string;
  url: string;
  colorTheme: "primary" | "emerald" | "indigo" | "rose" | "dark" | "outline";
  align: "left" | "center" | "full";
  borderRadius: "rounded" | "pill" | "sharp";
}

export interface OtpBlock {
  type: "otp";
  id: string;
  codeVar: string;
  expiryText?: string;
  securityNotice?: string;
}

export interface CalloutBlock {
  type: "callout";
  id: string;
  variant: "info" | "success" | "warning" | "neutral";
  title?: string;
  text: string;
}

export interface KeyValueBlock {
  type: "keyvalue";
  id: string;
  items: { key: string; value: string }[];
}

export interface DividerBlock {
  type: "divider";
  id: string;
  spacing: "sm" | "md" | "lg";
  lineStyle?: "solid" | "dashed" | "dots";
}

export interface FooterBlock {
  type: "footer";
  id: string;
  companyName: string;
  address?: string;
  unsubscribeUrl?: string;
  supportEmail?: string;
  align?: "left" | "center";
}

export type TemplateBlock =
  | HeaderBlock
  | HeroBlock
  | TextBlock
  | ButtonBlock
  | OtpBlock
  | CalloutBlock
  | KeyValueBlock
  | DividerBlock
  | FooterBlock;

export interface PresetTemplate {
  id: string;
  name: string;
  category: "starter" | "security" | "onboarding" | "transactional" | "marketing" | "personal";
  subject: string;
  description: string;
  defaultVars: Record<string, string>;
  theme: TemplateTheme;
  blocks: TemplateBlock[];
  html: string;
  text: string;
}

export const DEFAULT_THEME: TemplateTheme = {
  primaryColor: "#0f172a",
  bgColor: "#f8fafc",
  cardBgColor: "#ffffff",
  textColor: "#1e293b",
  fontFamily: "sans",
  headingFontFamily: "sans",
  borderRadius: "rounded",
  maxWidth: 580,
  contentPadding: 32,
};

export function extractVars(subject: string, html: string, text?: string): string[] {
  const all = `${subject || ""} ${html || ""} ${text || ""}`;
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(all)) !== null) {
    const key = m[1].trim();
    if (key) set.add(key);
  }
  return Array.from(set);
}

export function renderWithVars(str: string, vars: Record<string, string>): string {
  if (!str) return "";
  return str.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, rawKey) => {
    const key = rawKey.trim();
    return vars[key] !== undefined && vars[key] !== "" ? vars[key] : match;
  });
}

export function htmlToPlainText(html: string): string {
  if (!html) return "";
  let clean = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*[\/]?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<td[^>]*>/gi, " ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "");

  clean = clean
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return clean.replace(/\n{3,}/g, "\n\n").trim();
}

export function compileVisualBlocksToHtml(blocks: TemplateBlock[], theme: TemplateTheme = DEFAULT_THEME): string {
  const radiusMap = {
    sharp: "0px",
    rounded: "10px",
    curved: "18px",
  };

  const fontFamily = sanitizeFontStack(resolveFontStack(theme.fontFamily), FONT_OPTIONS[0].stack);
  const radius = radiusMap[theme.borderRadius] || "10px";
  const padding = theme.contentPadding ?? 32;
  const safeBg = sanitizeColor(theme.bgColor, DEFAULT_THEME.bgColor);
  const safeCardBg = sanitizeColor(theme.cardBgColor, DEFAULT_THEME.cardBgColor);
  const safePrimary = sanitizeColor(theme.primaryColor, DEFAULT_THEME.primaryColor);
  const safeText = sanitizeColor(theme.textColor, DEFAULT_THEME.textColor);

  const blockHtmls = blocks.map((b) => {
    switch (b.type) {
      case "header": {
        const alignStyle = b.align === "center" ? "text-align: center;" : "text-align: left;";
        const brandFont = sanitizeFontStack(resolveFontStack((b as HeaderBlock).fontFamily || theme.headingFontFamily || theme.fontFamily), fontFamily);
        const logoH = (b as HeaderBlock).logoHeight ?? 38;
        const safeLogoH = Number.isFinite(logoH) ? Math.min(200, Math.max(16, logoH)) : 38;
        const safeLogoUrl = sanitizeUrl(b.logoUrl);
        const safeBrand = escapeHtml(b.brandName);
        const safeBadge = escapeHtml(b.badgeText ?? "");
        return `
          <div style="padding-bottom: 24px; border-bottom: 1px solid #f1f5f9; margin-bottom: 24px; ${alignStyle}">
            ${
              b.logoUrl
                ? `<img src="${escapeAttr(safeLogoUrl)}" alt="${escapeAttr(b.brandName)}" style="max-height: ${safeLogoH}px; width: auto; vertical-align: middle; display: inline-block;" />`
                : `<span style="font-family: ${brandFont}; font-size: 19px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em;">${safeBrand}</span>`
            }
            ${
              b.badgeText
                ? `<span style="margin-left: 10px; display: inline-block; background-color: #f1f5f9; color: #475569; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 9999px; vertical-align: middle; font-family: ${fontFamily};">${safeBadge}</span>`
                : ""
            }
          </div>
        `;
      }
      case "hero": {
        const alignStyle = b.align === "center" ? "text-align: center;" : "text-align: left;";
        const heroFont = sanitizeFontStack(resolveFontStack(b.fontFamily || theme.headingFontFamily || theme.fontFamily), fontFamily);
        const titleSizes = { sm: "22px", md: "26px", lg: "32px", xl: "38px" };
        const titleSize = titleSizes[b.titleSize ?? "md"];
        return `
          <div style="margin-bottom: 24px; ${alignStyle}">
            ${
              b.eyebrow
                ? `<p style="margin: 0 0 8px; font-family: ${fontFamily}; font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${safePrimary};">${escapeHtml(b.eyebrow)}</p>`
                : ""
            }
            <h1 style="margin: 0 0 10px; font-family: ${heroFont}; font-size: ${titleSize}; font-weight: 700; color: #0f172a; line-height: 1.25; letter-spacing: -0.025em;">${escapeHtml(b.title)}</h1>
            ${
              b.subtitle
                ? `<p style="margin: 0; font-family: ${fontFamily}; font-size: 15px; line-height: 1.5; color: #64748b;">${escapeHtml(b.subtitle)}</p>`
                : ""
            }
          </div>
        `;
      }
      case "text": {
        const sizeMap = {
          sm: "font-size: 13.5px; line-height: 1.6;",
          base: "font-size: 15px; line-height: 1.65;",
          lg: "font-size: 16.5px; line-height: 1.6;",
        };
        const alignMap = { left: "text-align: left;", center: "text-align: center;", right: "text-align: right;" };
        const tAlign = alignMap[(b as TextBlock).align ?? "left"];
        const tFont = sanitizeFontStack(resolveFontStack((b as TextBlock).fontFamily || theme.fontFamily), fontFamily);
        const paragraphs = escapeHtml(b.content).split(/\n{2,}/).map((p) => {
          const lines = p.split("\n").join("<br />");
          return `<p style="margin: 0 0 16px; font-family: ${tFont}; color: ${safeText}; ${sizeMap[b.fontSize] || sizeMap.base} ${tAlign}">${lines}</p>`;
        });
        return `<div>${paragraphs.join("")}</div>`;
      }
      case "button": {
        const colorStyles: Record<string, { bg: string; text: string; border?: string }> = {
          primary: { bg: safePrimary, text: "#ffffff" },
          emerald: { bg: "#059669", text: "#ffffff" },
          indigo: { bg: "#4f46e5", text: "#ffffff" },
          rose: { bg: "#e11d48", text: "#ffffff" },
          dark: { bg: "#09090b", text: "#ffffff" },
          outline: { bg: "transparent", text: safeText, border: "1px solid #cbd5e1" },
        };
        const col = colorStyles[b.colorTheme] || colorStyles.primary;
        const btnRadius = b.borderRadius === "pill" ? "9999px" : b.borderRadius === "sharp" ? "0px" : "8px";
        const alignWrapper =
          b.align === "center"
            ? "text-align: center;"
            : b.align === "full"
            ? "text-align: center; display: block;"
            : "text-align: left;";
        const widthStyle = b.align === "full" ? "display: block; width: 100%; box-sizing: border-box;" : "display: inline-block;";
        const safeBtnUrl = escapeAttr(sanitizeUrl(b.url));
        const safeBtnText = escapeHtml(b.text);

        return `
          <div style="margin: 24px 0; ${alignWrapper}">
            <a href="${safeBtnUrl}" style="${widthStyle} background-color: ${col.bg}; color: ${col.text}; ${col.border ? `border: ${col.border};` : ""} padding: 13px 28px; font-size: 14.5px; font-weight: 600; text-decoration: none; border-radius: ${btnRadius}; text-align: center; transition: opacity 0.2s;">
              ${safeBtnText}
            </a>
          </div>
        `;
      }
      case "otp": {
        return `
          <div style="margin: 28px 0; background-color: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 12px; padding: 24px 16px; text-align: center;">
            <p style="margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b;">Verification Code</p>
            <div style="font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #0f172a; padding: 6px 0; text-indent: 8px;">
              ${escapeHtml(b.codeVar)}
            </div>
            ${
              b.expiryText
                ? `<p style="margin: 10px 0 0; font-size: 12.5px; font-weight: 500; color: #64748b;">${escapeHtml(b.expiryText)}</p>`
                : ""
            }
            ${
              b.securityNotice
                ? `<p style="margin: 6px 0 0; font-size: 11.5px; color: #94a3b8;">${escapeHtml(b.securityNotice)}</p>`
                : ""
            }
          </div>
        `;
      }
      case "callout": {
        const variants = {
          info: { bg: "#eff6ff", border: "#bfdbfe", text: "#1e40af", title: "#1e3a8a" },
          success: { bg: "#ecfdf5", border: "#a7f3d0", text: "#065f46", title: "#064e3b" },
          warning: { bg: "#fffbeb", border: "#fde68a", text: "#92400e", title: "#78350f" },
          neutral: { bg: "#f8fafc", border: "#e2e8f0", text: "#334155", title: "#0f172a" },
        };
        const v = variants[b.variant] || variants.info;
        return `
          <div style="margin: 20px 0; background-color: ${v.bg}; border: 1px solid ${v.border}; border-radius: 8px; padding: 14px 18px;">
            ${b.title ? `<p style="margin: 0 0 4px; font-size: 13.5px; font-weight: 700; color: ${v.title};">${escapeHtml(b.title)}</p>` : ""}
            <p style="margin: 0; font-size: 13px; line-height: 1.5; color: ${v.text};">${escapeHtml(b.text)}</p>
          </div>
        `;
      }
      case "keyvalue": {
        const rows = b.items
          .map(
            (item) => `
            <tr>
              <td style="padding: 9px 0; font-size: 13.5px; color: #64748b; font-weight: 500; border-bottom: 1px solid #f1f5f9;">${escapeHtml(item.key)}</td>
              <td style="padding: 9px 0; font-size: 13.5px; color: #0f172a; font-weight: 600; text-align: right; border-bottom: 1px solid #f1f5f9;">${escapeHtml(item.value)}</td>
            </tr>
          `
          )
          .join("");
        return `
          <div style="margin: 20px 0; background-color: #fafbfc; border-radius: 8px; padding: 12px 18px;">
            <table style="width: 100%; border-collapse: collapse;">
              ${rows}
            </table>
          </div>
        `;
      }
      case "divider": {
        const margins = { sm: "16px 0", md: "28px 0", lg: "40px 0" };
        const style = (b as DividerBlock).lineStyle ?? "solid";
        if (style === "dots") {
          return `<div style="margin: ${margins[b.spacing] || "28px 0"}; text-align: center; font-size: 14px; letter-spacing: 8px; color: #cbd5e1;">● ● ●</div>`;
        }
        if (style === "dashed") {
          return `<hr style="margin: ${margins[b.spacing] || "28px 0"}; border: none; border-top: 2px dashed #cbd5e1;" />`;
        }
        return `<hr style="margin: ${margins[b.spacing] || "28px 0"}; border: none; border-top: 1px solid #e2e8f0;" />`;
      }
      case "footer": {
        const fAlign = (b as FooterBlock).align ?? "center";
        const alignStyle = fAlign === "left" ? "text-align: left;" : "text-align: center;";
        const safeSupport = b.supportEmail ? sanitizeUrl(`mailto:${b.supportEmail.trim()}`) : "";
        const safeUnsub = b.unsubscribeUrl ? sanitizeUrl(b.unsubscribeUrl) : "";
        return `
          <div style="margin-top: 36px; padding-top: 24px; border-top: 1px solid #e2e8f0; ${alignStyle} font-family: ${fontFamily}; font-size: 12px; line-height: 1.6; color: #94a3b8;">
            <p style="margin: 0 0 6px; font-weight: 600; color: #64748b;">${escapeHtml(b.companyName)}</p>
            ${b.address ? `<p style="margin: 0 0 6px;">${escapeHtml(b.address)}</p>` : ""}
            <p style="margin: 0;">
              ${b.supportEmail ? `<a href="${escapeAttr(safeSupport)}" style="color: #64748b; text-decoration: underline;">Contact support</a> · ` : ""}
              ${b.unsubscribeUrl ? `<a href="${escapeAttr(safeUnsub)}" style="color: #64748b; text-decoration: underline;">Unsubscribe</a>` : ""}
            </p>
          </div>
        `;
      }
      default:
        return "";
    }
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Email</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${safeBg}; font-family: ${fontFamily}; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${safeBg};">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: ${theme.maxWidth}px; background-color: ${safeCardBg}; border-radius: ${radius}; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.02); border: 1px solid #e2e8f0; overflow: hidden;">
          <tr>
            <td style="padding: 36px ${padding}px;">
              ${blockHtmls.join("")}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const BLANK_TEMPLATE: PresetTemplate = {
  id: "blank_canvas",
  name: "blank_template",
  category: "starter",
  subject: "",
  description: "Start from complete zero. Clean slate with minimal boilerplate — ready for raw HTML or building custom blocks.",
  defaultVars: {},
  theme: {
    ...DEFAULT_THEME,
    primaryColor: "#0f172a",
    borderRadius: "rounded",
    maxWidth: 580,
  },
  blocks: [
    {
      type: "text",
      id: "txt-blank",
      content: "Start typing your email message here...",
      fontSize: "base",
    },
  ],
  html: "",
  text: "Start typing your email message here...",
};

export const PRESET_TEMPLATES: PresetTemplate[] = [
  BLANK_TEMPLATE,
  {
    id: "security_otp",
    name: "verify_code",
    category: "security",
    subject: "Your verification code is {{code}}",
    description: "Sleek security verification with high-contrast PIN card, expiration warning, and security footer.",
    defaultVars: {
      name: "Alex",
      code: "482 913",
      company: "MailerGo",
      expires_in: "10 minutes",
    },
    theme: {
      ...DEFAULT_THEME,
      primaryColor: "#0f172a",
      borderRadius: "rounded",
    },
    blocks: [
      {
        type: "header",
        id: "hdr-1",
        brandName: "{{company}}",
        badgeText: "Security Verification",
        align: "left",
      },
      {
        type: "hero",
        id: "hero-1",
        eyebrow: "Account Security",
        title: "Verify your request",
        subtitle: "Please enter the one-time verification code below to confirm your login.",
        align: "left",
      },
      {
        type: "text",
        id: "txt-1",
        content: "Hi {{name}},\n\nWe received a sign-in or authorization attempt for your account. Use this one-time code to proceed:",
        fontSize: "base",
      },
      {
        type: "otp",
        id: "otp-1",
        codeVar: "{{code}}",
        expiryText: "This code expires in {{expires_in}}.",
        securityNotice: "Never share this code with anyone. MailerGo staff will never ask for your code.",
      },
      {
        type: "callout",
        id: "call-1",
        variant: "warning",
        title: "Didn't request this code?",
        text: "If this was not you, someone may be trying to access your account. Change your password immediately.",
      },
      {
        type: "footer",
        id: "ft-1",
        companyName: "{{company}} Security Systems Inc.",
        address: "100 Pine Street, San Francisco, CA",
        supportEmail: "security@{{company}}.com",
      },
    ],
    html: "",
    text: "Hi {{name}},\n\nYour verification code is: {{code}}\n\nIt expires in {{expires_in}}. If you did not request this code, please secure your account.",
  },
  {
    id: "welcome_onboarding",
    name: "welcome_user",
    category: "onboarding",
    subject: "Welcome to {{company}}, {{name}}!",
    description: "Modern welcome email with hero graphic, quick start call-to-action button, and plan summary.",
    defaultVars: {
      name: "Sara",
      company: "MailerGo",
      plan: "Pro Workspace",
      dashboard_url: "https://mailer.lukaulcar.com/dashboard",
    },
    theme: {
      ...DEFAULT_THEME,
      primaryColor: "#0f172a",
      borderRadius: "rounded",
    },
    blocks: [
      {
        type: "header",
        id: "hdr-w",
        brandName: "{{company}}",
        badgeText: "Welcome",
        align: "left",
      },
      {
        type: "hero",
        id: "hero-w",
        eyebrow: "Getting Started",
        title: "You're all set, {{name}}!",
        subtitle: "Your new workspace is ready. Let's get you set up to send your first message in minutes.",
        align: "left",
      },
      {
        type: "text",
        id: "txt-w",
        content: "We're super excited to have you on board! With MailerGo, you get rock-solid email delivery, scoped transactional API keys, and custom DNS DKIM signing with zero friction.",
        fontSize: "base",
      },
      {
        type: "button",
        id: "btn-w",
        text: "Open Workspace Dashboard →",
        url: "{{dashboard_url}}",
        colorTheme: "primary",
        align: "center",
        borderRadius: "rounded",
      },
      {
        type: "keyvalue",
        id: "kv-w",
        items: [
          { key: "Assigned Plan", value: "{{plan}}" },
          { key: "API Status", value: "Active & Ready" },
          { key: "Documentation", value: "docs.mailer.lukaulcar.com" },
        ],
      },
      {
        type: "text",
        id: "txt-w2",
        content: "If you have any questions or need assistance connecting your custom domain, simply reply to this email.",
        fontSize: "sm",
      },
      {
        type: "footer",
        id: "ft-w",
        companyName: "{{company}} Team",
        address: "support@mailer.lukaulcar.com",
        supportEmail: "support@mailer.lukaulcar.com",
      },
    ],
    html: "",
    text: "Welcome to {{company}}, {{name}}!\n\nYour workspace is ready: {{dashboard_url}}\n\nPlan: {{plan}}\n\nReply anytime if you need help getting started.",
  },
  {
    id: "password_reset",
    name: "password_reset",
    category: "security",
    subject: "Reset your {{company}} password",
    description: "Security-focused password reset message with direct action button and expiration countdown.",
    defaultVars: {
      name: "Marcus",
      company: "MailerGo",
      reset_url: "https://mailer.lukaulcar.com/auth/reset?token=sample_token",
      expires_in: "30 minutes",
    },
    theme: {
      ...DEFAULT_THEME,
      primaryColor: "#0f172a",
      borderRadius: "rounded",
    },
    blocks: [
      {
        type: "header",
        id: "hdr-p",
        brandName: "{{company}}",
        align: "left",
      },
      {
        type: "hero",
        id: "hero-p",
        eyebrow: "Account Access",
        title: "Password reset request",
        subtitle: "We received a request to change the password for your account.",
        align: "left",
      },
      {
        type: "text",
        id: "txt-p",
        content: "Hi {{name}},\n\nClick the button below to choose a new password. This reset link will safely expire in {{expires_in}}.",
        fontSize: "base",
      },
      {
        type: "button",
        id: "btn-p",
        text: "Reset My Password",
        url: "{{reset_url}}",
        colorTheme: "primary",
        align: "center",
        borderRadius: "rounded",
      },
      {
        type: "callout",
        id: "call-p",
        variant: "neutral",
        title: "Button not working?",
        text: "Copy and paste this URL into your browser:\n{{reset_url}}",
      },
      {
        type: "footer",
        id: "ft-p",
        companyName: "{{company}} Security",
        supportEmail: "security@mailer.lukaulcar.com",
      },
    ],
    html: "",
    text: "Hi {{name}},\n\nReset your {{company}} password by opening this link within {{expires_in}}:\n{{reset_url}}\n\nIf you did not request this, you can safely ignore this email.",
  },
  {
    id: "payment_receipt",
    name: "payment_receipt",
    category: "transactional",
    subject: "Receipt for Order #{{order_id}} — {{amount}}",
    description: "Clean invoice receipt with itemized transaction breakdown, order reference, and PDF download button.",
    defaultVars: {
      name: "Elena",
      company: "MailerGo",
      order_id: "MG-88492",
      amount: "$29.00 USD",
      date: "October 16, 2026",
      plan: "Dedicated MX Pro (Monthly)",
      receipt_url: "https://mailer.lukaulcar.com/invoices/MG-88492.pdf",
    },
    theme: {
      ...DEFAULT_THEME,
      primaryColor: "#0f172a",
      borderRadius: "rounded",
    },
    blocks: [
      {
        type: "header",
        id: "hdr-rec",
        brandName: "{{company}}",
        badgeText: "Paid",
        align: "left",
      },
      {
        type: "hero",
        id: "hero-rec",
        eyebrow: "Payment Successful",
        title: "Thank you for your business!",
        subtitle: "Your payment of {{amount}} has been processed successfully.",
        align: "left",
      },
      {
        type: "keyvalue",
        id: "kv-rec",
        items: [
          { key: "Invoice / Order #", value: "{{order_id}}" },
          { key: "Date", value: "{{date}}" },
          { key: "Item", value: "{{plan}}" },
          { key: "Total Paid", value: "{{amount}}" },
          { key: "Payment Status", value: "Completed ✓" },
        ],
      },
      {
        type: "button",
        id: "btn-rec",
        text: "Download PDF Receipt",
        url: "{{receipt_url}}",
        colorTheme: "outline",
        align: "center",
        borderRadius: "rounded",
      },
      {
        type: "footer",
        id: "ft-rec",
        companyName: "{{company}} Billing",
        supportEmail: "billing@mailer.lukaulcar.com",
      },
    ],
    html: "",
    text: "Payment Receipt for Order #{{order_id}}\n\nAmount: {{amount}}\nDate: {{date}}\nItem: {{plan}}\n\nDownload PDF: {{receipt_url}}",
  },
  {
    id: "product_update",
    name: "product_newsletter",
    category: "marketing",
    subject: "Introducing {{feature_name}} in {{company}}",
    description: "Polished feature announcement and newsletter format with highlight cards and changelog link.",
    defaultVars: {
      name: "Developer",
      company: "MailerGo",
      feature_name: "Automated DKIM Key Rotation",
      feature_highlight: "Zero-downtime 2048-bit RSA key rotation with auto DNS health probes.",
      docs_url: "https://mailer.lukaulcar.com/changelog",
    },
    theme: {
      ...DEFAULT_THEME,
      primaryColor: "#0f172a",
      borderRadius: "rounded",
    },
    blocks: [
      {
        type: "header",
        id: "hdr-u",
        brandName: "{{company}} Changelog",
        align: "left",
      },
      {
        type: "hero",
        id: "hero-u",
        eyebrow: "Feature Release",
        title: "{{feature_name}} is now live!",
        subtitle: "A major upgrade to give you even stronger email deliverability and reputation.",
        align: "left",
      },
      {
        type: "text",
        id: "txt-u",
        content: "Hi {{name}},\n\nWe're excited to introduce {{feature_name}}. {{feature_highlight}}\n\nHere is what you get out of the box:\n• Instant DNS record verification\n• Live webhook streaming for bounces and deliveries\n• Scoped API keys with granular mailbox and template permissions",
        fontSize: "base",
      },
      {
        type: "button",
        id: "btn-u",
        text: "Read Full Changelog →",
        url: "{{docs_url}}",
        colorTheme: "primary",
        align: "center",
        borderRadius: "rounded",
      },
      {
        type: "footer",
        id: "ft-u",
        companyName: "{{company}}",
        address: "San Francisco, CA",
        unsubscribeUrl: "https://mailer.lukaulcar.com/unsubscribe",
      },
    ],
    html: "",
    text: "Introducing {{feature_name}} in {{company}}!\n\n{{feature_highlight}}\n\nRead more at {{docs_url}}",
  },
  {
    id: "personal_note",
    name: "direct_outreach",
    category: "personal",
    subject: "Quick question regarding {{topic}}",
    description: "Clean, human personal letter style without marketing clutter, ideal for high-response outreach.",
    defaultVars: {
      name: "Jordan",
      sender_name: "Luke",
      company: "MailerGo",
      topic: "your custom domain setup",
      cal_url: "https://cal.com/luke/15min",
    },
    theme: {
      ...DEFAULT_THEME,
      primaryColor: "#0f172a",
      borderRadius: "sharp",
      maxWidth: 540,
    },
    blocks: [
      {
        type: "text",
        id: "txt-pers",
        content: "Hi {{name}},\n\nI was looking over your configuration and wanted to reach out regarding {{topic}}.\n\nEverything is working smoothly, but I wanted to make sure you have everything you need for high volume throughput. Would you be open to a 10-minute check-in this week?\n\nFeel free to grab any time that suits you on my calendar, or simply reply to this email.",
        fontSize: "base",
      },
      {
        type: "button",
        id: "btn-pers",
        text: "Pick a Time on My Calendar",
        url: "{{cal_url}}",
        colorTheme: "dark",
        align: "left",
        borderRadius: "rounded",
      },
      {
        type: "text",
        id: "txt-pers2",
        content: "Best regards,\n{{sender_name}}\n{{company}}",
        fontSize: "base",
      },
      {
        type: "footer",
        id: "ft-pers",
        companyName: "{{company}}",
        address: "{{sender_name}} · {{company}} Founder",
        supportEmail: "luke@mailer.lukaulcar.com",
      },
    ],
    html: "",
    text: "Hi {{name}},\n\nI wanted to reach out regarding {{topic}}. Would you have 10 minutes to chat this week?\n\nSchedule a time: {{cal_url}}\n\nBest,\n{{sender_name}}\n{{company}}",
  },
];

for (const p of PRESET_TEMPLATES) {
  p.html = compileVisualBlocksToHtml(p.blocks, p.theme);
}
