export const cx = (...parts: Array<string | false | undefined | null>) =>
  parts.filter(Boolean).join(" ");

export const fieldCls =
  "w-full rounded-md border border-neutral-200 bg-white px-3 py-2.5 text-[13.5px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none transition";

export const authFieldCls =
  "w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-[14.5px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none transition-colors";

export const labelCls = "mb-1.5 block text-[12.5px] font-semibold text-neutral-900";

export const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
