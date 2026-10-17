import { useMemo } from "react";
import { getCleanMessageContent } from "../lib/mailParser";
import { StarIcon } from "./icons";

function linkify(body: string): React.ReactNode[] {
  const urlRe = /(https?:\/\/[^\s]+)/g;
  const parts = body.split(urlRe);
  
  
  const isUrl = /^https?:\/\/[^\s]+$/;
  return parts.map((p, i) => {
    if (!isUrl.test(p)) {
      return <span key={i}>{p}</span>;
    }
    
    const m = p.match(/^(.*?)([.,;:!?)\]]+)$/);
    const href = m ? m[1] : p;
    const trail = m ? m[2] : "";
    return (
      <span key={i}>
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#1a73e8] underline underline-offset-2">
          {href}
        </a>
        {trail}
      </span>
    );
  });
}

export interface GmailPreviewProps {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  body?: string;
  html?: string;
  date?: string;
  iframeHeightClass?: string;
}

export default function GmailPreview({
  from,
  fromName,
  to,
  subject,
  body = "",
  html,
  date,
  iframeHeightClass,
}: GmailPreviewProps) {
  const { text: cleanBody, html: cleanHtml } = useMemo(
    () => getCleanMessageContent({ body, body_html: html }),
    [body, html],
  );
  const dateLabel = useMemo(() => {
    if (!date) return " · now";
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? "" : ` · ${d.toLocaleString()}`;
  }, [date]);
  const paragraphs = useMemo(() => (cleanBody ? cleanBody.split(/\n{2,}/) : []), [cleanBody]);
  const doc = useMemo(() => {
    if (!cleanHtml) return "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">${cleanHtml}</body></html>`;
  }, [cleanHtml]);

  const displayFrom = fromName?.trim() || from;

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white text-left">
      <div className="flex items-center gap-3 border-b border-neutral-100 bg-[#f6f8fc] px-5 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300" />
        </span>
        <p className="truncate font-mono text-[11px] text-neutral-400">Gmail · receiver view — exactly what they see</p>
      </div>

      <div className="px-5 pb-5 pt-4 sm:px-7 sm:pt-5">
        <h3 className="text-[19px] font-semibold leading-snug text-neutral-900">{subject || "(no subject)"}</h3>

        <div className="mt-3 flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#1a73e8] text-[14px] font-bold text-white" aria-hidden="true">
            {(displayFrom.charAt(0) || "?").toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] text-neutral-900">
              <span className="font-bold">{displayFrom}</span>
              {fromName?.trim() ? <span className="text-neutral-400"> &lt;{from}&gt;</span> : null}
            </p>
            <p className="truncate text-[12px] text-neutral-500">
              to {to || "someone@example.com"}
              {dateLabel}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-neutral-400" aria-hidden="true">
            <StarIcon strokeWidth={1.5} />
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M4 9a6 6 0 0 1 11-3M16 11a6 6 0 0 1-11 3M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>

        {cleanHtml ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
            <iframe
              title="Gmail HTML preview"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={doc}
              className={iframeHeightClass ?? "h-[420px] w-full bg-white xl:h-[620px]"}
            />
          </div>
        ) : (
          <div className="mt-4 space-y-3 text-[14px] leading-[1.7] text-neutral-800">
            {paragraphs.map((p, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {p.split("\n").map((line, j, arr) => (
                  <span key={j}>
                    {linkify(line)}
                    {j < arr.length - 1 && <br />}
                  </span>
                ))}
              </p>
            ))}
            {cleanBody.trim() === "" && <p className="text-neutral-400">(empty body)</p>}
          </div>
        )}

        <div className="mt-5 flex gap-2 border-t border-neutral-100 pt-4">
          <span className="rounded-md border border-neutral-200 px-4 py-1.5 text-[12.5px] font-semibold text-neutral-500">Reply</span>
          <span className="rounded-md border border-neutral-200 px-4 py-1.5 text-[12.5px] font-semibold text-neutral-500">Forward</span>
        </div>
      </div>
    </div>
  );
}
