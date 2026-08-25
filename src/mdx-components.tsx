import { PreBlock } from "@/components/docs/pre-block";
import { cn } from "@/lib/cn";
import type { MDXComponents } from "mdx/types";

/**
 * 全局 MDX 组件映射（docs 页渲染用，风格对齐控制台 token）：
 * - 标题/段落/表格/列表/链接等按控制台字体与颜色体系排版；
 * - 代码块交给 PreBlock（浅底卡片 + 语言标签 + 复制）；
 * - Note / Warn / Danger 三个提示框组件供 MDX 显式调用。
 */

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
      {children}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 rounded-md border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
      {children}
    </div>
  );
}

function Danger({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 rounded-md border border-bad/40 bg-bad-soft px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
      {children}
    </div>
  );
}

/** 接口分节条：方法徽标 + 路径 + 名称，粗下边框，作为每个接口小节的醒目分界。 */
function Endpoint({
  id,
  method,
  path,
  name,
}: {
  id?: string;
  method: string;
  path: string;
  name?: string;
}) {
  return (
    <div
      id={id}
      className="mt-12 mb-4 flex scroll-mt-6 flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b-2 border-line-strong pb-2"
    >
      <Method method={method} />
      <code className="font-mono text-[15px] font-semibold text-text">{path}</code>
      {name ? <span className="text-[13px] text-text-muted">· {name}</span> : null}
    </div>
  );
}

/** HTTP 方法徽标，用于接口表格与小节标题（GET/POST/PUT/PATCH/DELETE/HEAD）。 */
function Method({ method }: { method: string }) {
  const tones: Record<string, string> = {
    GET: "border-info/40 bg-info-soft text-info",
    POST: "border-ok/40 bg-ok-soft text-ok",
    PUT: "border-warn/40 bg-warn-soft text-warn",
    PATCH: "border-warn/40 bg-warn-soft text-warn",
    DELETE: "border-bad/40 bg-bad-soft text-bad",
    HEAD: "border-line bg-surface-sunken text-text-muted",
  };
  const cls = tones[method] ?? "border-line bg-surface-sunken text-text-muted";
  return (
    <span
      className={cn(
        "inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
        cls,
      )}
    >
      {method}
    </span>
  );
}

const components: MDXComponents = {
  Note,
  Warn,
  Danger,
  Method,
  Endpoint,
  h1: ({ children }) => (
    <h1 className="mt-1 mb-5 text-[22px] leading-tight font-semibold text-text">{children}</h1>
  ),
  h2: ({ id, children }) => (
    <h2
      id={id}
      className="mt-12 mb-4 scroll-mt-6 border-b border-line-strong pb-2 text-[17px] font-semibold text-text"
    >
      {children}
    </h2>
  ),
  h3: ({ id, children }) => (
    <h3 id={id} className="mt-8 mb-2 scroll-mt-6 text-[15px] font-semibold text-text-secondary">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="my-2 text-[13.5px] leading-relaxed text-text-secondary">{children}</p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:text-accent-hover"
    >
      {children}
    </a>
  ),
  inlineCode: ({ children }) => (
    <code className="rounded-sm border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] text-text-secondary">
      {children}
    </code>
  ),
  pre: (props) => <PreBlock {...props} />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-[13px] text-text-secondary">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-hover/70 text-left">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line px-3 py-2 text-[11px] font-semibold tracking-wide text-text-faint">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-line px-3 py-2 align-top text-text-secondary last:border-b-0">
      {children}
    </td>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-text-secondary">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 text-[13.5px] leading-relaxed text-text-secondary">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <div className="my-4 rounded-md border-l-2 border-accent bg-accent-soft/70 px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
      {children}
    </div>
  ),
  hr: () => <hr className="my-10 border-line" />,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
};

export function useMDXComponents(): MDXComponents {
  return components;
}

export { Note, Warn, Danger };
