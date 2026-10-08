"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const LINKS = [
  { href: "/projects", label: "Proyek" },
  { href: "/experiments", label: "Eksperimen" },
  { href: "/settings", label: "Pengaturan" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex items-center gap-1 text-sm">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cx("rounded-md px-2.5 py-1.5 transition-colors", active ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-surface-2 hover:text-text")}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
