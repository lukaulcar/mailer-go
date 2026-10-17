import { useRef, useMemo } from "react";
import { highlightHtml } from "../lib/htmlHighlight";

interface HtmlCodeEditorProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  id?: string;
  minHeight?: number | string;
  maxHeight?: number | string;
}

export default function HtmlCodeEditor({
  value,
  onChange,
  placeholder = "<!DOCTYPE html>\n<html>\n  <body>\n    <!-- Your email markup here -->\n  </body>\n</html>",
  id = "template-html-editor",
  minHeight = 440,
  maxHeight = 620,
}: HtmlCodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  
  const highlightedHtml = useMemo(() => {
    const raw = highlightHtml(value);
    
    return raw ? raw + "<br />" : "";
  }, [value]);

  
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const textarea = e.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (e.key === "Tab") {
      e.preventDefault();
      const tabSpaces = "  ";

      if (e.shiftKey) {
        
        const linesBefore = value.substring(0, start).split("\n");
        const currentLine = linesBefore[linesBefore.length - 1];
        if (currentLine.startsWith("  ")) {
          const lineStartPos = start - currentLine.length;
          const nextVal = value.substring(0, lineStartPos) + currentLine.slice(2) + value.substring(start);
          onChange(nextVal);
          requestAnimationFrame(() => {
            textarea.selectionStart = Math.max(0, start - 2);
            textarea.selectionEnd = Math.max(0, end - 2);
          });
        }
      } else {
        
        const nextVal = value.substring(0, start) + tabSpaces + value.substring(end);
        onChange(nextVal);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + tabSpaces.length;
          textarea.selectionEnd = start + tabSpaces.length;
        });
      }
    } else if (e.key === "Enter") {
      
      const linesBefore = value.substring(0, start).split("\n");
      const currentLine = linesBefore[linesBefore.length - 1];
      const match = currentLine.match(/^(\s+)/);
      if (match) {
        e.preventDefault();
        const indent = match[1];
        const nextVal = value.substring(0, start) + "\n" + indent + value.substring(end);
        onChange(nextVal);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 1 + indent.length;
          textarea.selectionEnd = start + 1 + indent.length;
        });
      }
    }
  }

  const minHeightVal = typeof minHeight === "number" ? `${minHeight}px` : minHeight;
  const maxHeightVal = typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;

  return (
    <div className="relative rounded-xl border border-neutral-800 bg-[#090d16] shadow-inner transition-colors focus-within:border-sky-500/50 focus-within:ring-1 focus-within:ring-sky-500/30">
      
      <div
        className="custom-code-scrollbar relative w-full overflow-auto"
        style={{
          minHeight: minHeightVal,
          maxHeight: maxHeightVal,
        }}
      >
        <div
          className="relative w-full"
          style={{
            minHeight: minHeightVal,
          }}
        >
          
          <pre
            aria-hidden="true"
            className="html-code-editor pointer-events-none m-0 block w-full p-4 font-mono text-[12.5px] leading-relaxed select-none whitespace-pre-wrap break-words"
            style={{
              fontFamily:
                'var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
              minHeight: minHeightVal,
            }}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />

          
          <textarea
            ref={textareaRef}
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="code-editor-textarea absolute inset-0 h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-[12.5px] leading-relaxed text-transparent caret-sky-400 focus:outline-none whitespace-pre-wrap break-words"
            style={{
              fontFamily:
                'var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
              WebkitTextFillColor: "transparent",
            }}
          />
        </div>
      </div>

      
      <div className="flex items-center justify-between border-t border-neutral-800/80 bg-[#060911]/90 px-3.5 py-1.5 text-[11px] font-mono text-neutral-400 select-none rounded-b-xl">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80"></span>
            <span className="text-neutral-300 font-medium">HTML5 + Variables</span>
          </span>
          <span className="text-neutral-600">|</span>
          <span>Tab: 2 spaces</span>
        </div>
        <div className="flex items-center gap-3">
          <span>{(value.match(/\n/g)?.length || 0) + 1} lines</span>
          <span className="text-neutral-600">·</span>
          <span>{value.length.toLocaleString()} chars</span>
        </div>
      </div>
    </div>
  );
}
