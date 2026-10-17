import { useState } from "react";
import {
  Download,
  Paperclip,
  FileText,
  Image as ImageIcon,
  FileCode,
  Archive,
  AlertTriangle,
  File,
  X,
  Eye,
} from "lucide-react";
import {
  type Attachment,
  formatAttachmentSize,
  isDangerousAttachment,
  downloadAttachment,
  getAttachmentPreviewUrl,
} from "../lib/api";

interface AttachmentListProps {
  attachments?: Attachment[];
  className?: string;
}

function getFileIcon(filename: string, contentType: string) {
  const lowerName = filename.toLowerCase();
  const lowerCT = contentType.toLowerCase();

  if (isDangerousAttachment(filename)) {
    return <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />;
  }

  if (lowerCT.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(lowerName)) {
    return <ImageIcon className="h-5 w-5 text-blue-500 shrink-0" />;
  }

  if (
    lowerCT.includes("pdf") ||
    lowerName.endsWith(".pdf") ||
    lowerCT.includes("word") ||
    lowerCT.includes("document") ||
    /\.(docx?|rtf|odt)$/i.test(lowerName)
  ) {
    return <FileText className="h-5 w-5 text-rose-500 shrink-0" />;
  }

  if (
    lowerCT.includes("zip") ||
    lowerCT.includes("tar") ||
    lowerCT.includes("compressed") ||
    /\.(zip|tar|gz|bz2|7z|rar)$/i.test(lowerName)
  ) {
    return <Archive className="h-5 w-5 text-amber-600 shrink-0" />;
  }

  if (
    lowerCT.includes("json") ||
    lowerCT.includes("javascript") ||
    lowerCT.includes("xml") ||
    lowerCT.includes("csv") ||
    /\.(json|csv|xml|sql|ts|js|py|go|rs|c|cpp|h)$/i.test(lowerName)
  ) {
    return <FileCode className="h-5 w-5 text-emerald-600 shrink-0" />;
  }

  return <File className="h-5 w-5 text-neutral-500 shrink-0" />;
}

export default function AttachmentList({
  attachments,
  className = "",
}: AttachmentListProps) {
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);

  if (!attachments || attachments.length === 0) {
    return null;
  }

  return (
    <div className={`mt-6 ${className}`}>
      <div className="flex items-center gap-2 pb-2 text-[13px] font-semibold text-neutral-800">
        <Paperclip className="h-4 w-4 text-neutral-500" />
        <span>Attachments</span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[11px] text-neutral-600">
          {attachments.length}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
        {attachments.map((att) => {
          const isImage =
            att.content_type?.toLowerCase().startsWith("image/") &&
            !att.content_type?.toLowerCase().includes("svg");
          const isDangerous = isDangerousAttachment(att.filename);
          const previewUrl = getAttachmentPreviewUrl(att.id);

          return (
            <div
              key={att.id}
              className={`group relative flex flex-col justify-between overflow-hidden rounded-xl border transition-all ${
                isDangerous
                  ? "border-amber-200 bg-amber-50/40 hover:border-amber-300"
                  : "border-neutral-200 bg-neutral-50/50 hover:border-neutral-300 hover:bg-neutral-50"
              }`}
            >
              {isImage ? (
                <div
                  onClick={() => setPreviewImage(att)}
                  className="relative h-28 w-full cursor-pointer overflow-hidden bg-neutral-100 flex items-center justify-center border-b border-neutral-100"
                >
                  <img
                    src={previewUrl}
                    alt={att.filename}
                    className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="inline-flex items-center gap-1 rounded-md bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-neutral-900 shadow-sm backdrop-blur-xs">
                      <Eye className="h-3.5 w-3.5" />
                      View
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="p-3">
                <div className="flex items-start gap-2.5">
                  {!isImage && (
                    <div className="mt-0.5 rounded-lg border border-neutral-200 bg-white p-2 shadow-2xs">
                      {getFileIcon(att.filename, att.content_type)}
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-[13px] font-medium text-neutral-900"
                      title={att.filename}
                    >
                      {att.filename}
                    </p>
                    <p className="mt-0.5 font-mono text-[11.5px] text-neutral-500">
                      {formatAttachmentSize(att.size_bytes)}
                    </p>
                  </div>
                </div>

                {isDangerous && (
                  <div className="mt-2.5 flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-100/60 px-2 py-1 text-[11px] font-medium text-amber-800">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <span>Executable file — caution</span>
                  </div>
                )}

                <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-neutral-200/60 pt-2.5">
                  {isImage && (
                    <button
                      type="button"
                      onClick={() => setPreviewImage(att)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-900"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Preview
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => downloadAttachment(att)}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-white border border-neutral-200 px-2.5 py-1 text-[11.5px] font-semibold text-neutral-800 shadow-2xs transition-colors hover:border-neutral-300 hover:bg-neutral-100"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {previewImage && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="relative flex max-h-[90vh] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <div className="min-w-0 flex-1 pr-4">
                <p className="truncate text-[14px] font-semibold text-neutral-900">
                  {previewImage.filename}
                </p>
                <p className="font-mono text-[11px] text-neutral-400">
                  {formatAttachmentSize(previewImage.size_bytes)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadAttachment(previewImage)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-neutral-800"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewImage(null)}
                  className="cursor-pointer rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="flex max-h-[calc(90vh-64px)] items-center justify-center overflow-auto bg-neutral-950/5 p-4">
              <img
                src={getAttachmentPreviewUrl(previewImage.id)}
                alt={previewImage.filename}
                className="max-h-[75vh] max-w-full rounded-md object-contain shadow-sm"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
