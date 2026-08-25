import Link from "next/link";

/**
 * 接口文档布局：左侧吸顶目录 + 右侧正文。
 * 锚点与 page.mdx 的 <h2 id=...> 一一对应（改正文标题时同步改这里）。
 */

const SECTIONS = [
  { href: "#quickstart", label: "1 · 快速开始" },
  { href: "#auth", label: "2 · 鉴权与 Token" },
  { href: "#endpoints", label: "3 · 核心接口" },
  { href: "#schedule", label: "4 · 调度参数" },
  { href: "#notification", label: "5 · 结果通知" },
  { href: "#envelope", label: "6 · 响应信封与错误码" },
  { href: "#appendix", label: "7 · 附录" },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-10">
      <aside className="sticky top-6 hidden h-fit w-48 shrink-0 lg:block">
        <p className="mb-3 text-[11px] font-semibold tracking-wider text-text-faint uppercase">
          目录
        </p>
        <nav aria-label="文档目录">
          <ul className="space-y-1.5 border-l border-line">
            {SECTIONS.map((s) => (
              <li key={s.href}>
                <Link
                  href={s.href}
                  className="-ml-px block border-l-2 border-transparent pl-3 text-[13px] text-text-muted transition-colors hover:border-accent hover:text-text"
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <article className="min-w-0 flex-1">{children}</article>
    </div>
  );
}
