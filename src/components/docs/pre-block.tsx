"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** MDX 代码块：浅底卡片 + 语言标签 + 复制按钮（点击时读取 pre 文本，非 HTTPS 有兜底）。 */
function PreBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useState<string | null>(null);

  useEffect(() => {
    const langMatch = ref.current?.querySelector("code")?.className?.match(/language-([\w+-]+)/);
    if (langMatch) setLang(langMatch[1] ?? null);
  }, []);

  const copy = async () => {
    const text = ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-3 overflow-hidden rounded-md border border-line bg-surface-sunken">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[10px] tracking-wider text-text-faint uppercase">
          {lang ?? "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="复制代码"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface hover:text-text"
        >
          {copied ? <Check className="h-3 w-3 text-ok" /> : <Copy className="h-3 w-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre
        ref={ref}
        className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-text"
      >
        {children}
      </pre>
    </div>
  );
}

export { PreBlock };
