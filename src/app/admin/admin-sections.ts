/**
 * OPE-1602 — admin pages the 2026-11-09 console review merges into one section.
 * Each section is one sidebar entry (its first tab) and a tab bar on every member.
 *
 * The routes stay where they are, so bookmarks and the /admin links in MCP output
 * and email templates keep working with no redirects.
 *
 * Duplicates is not here: it has its own layout and tab bar (OPE-1597).
 */
export type AdminSectionTab = { label: string; href: string };
export type AdminSection = { label: string; tabs: AdminSectionTab[] };

export const adminSections: AdminSection[] = [
  {
    label: "Claims",
    tabs: [
      { label: "Claim Review", href: "/admin/claims" },
      { label: "Vendor Claim", href: "/admin/vendor-claim-leaderboard" },
    ],
  },
  {
    label: "Inbox",
    tabs: [
      { label: "Inbound", href: "/admin/inbound-emails" },
      { label: "Sent", href: "/admin/sent-emails" },
      { label: "Correspondents", href: "/admin/correspondents" },
      { label: "Classifier Accuracy", href: "/admin/classifier-accuracy" },
      { label: "Source Suggestions", href: "/admin/email-source-suggestions" },
    ],
  },
  {
    label: "Import",
    tabs: [
      { label: "Import Events", href: "/admin/import" },
      { label: "Import from URL", href: "/admin/import-url" },
    ],
  },
  {
    label: "Sources",
    tabs: [
      { label: "Promoter Quality", href: "/admin/promoter-quality" },
      { label: "Source Quality", href: "/admin/source-quality" },
    ],
  },
  {
    label: "Blog",
    tabs: [
      { label: "Posts", href: "/admin/blog" },
      { label: "Coverage gaps", href: "/admin/coverage" },
    ],
  },
];

/** The section whose tab is exactly this path. Detail pages get no tab bar. */
export function findAdminSection(pathname: string): AdminSection | undefined {
  return adminSections.find((section) => section.tabs.some((tab) => tab.href === pathname));
}
