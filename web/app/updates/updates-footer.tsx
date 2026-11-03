import Link from "next/link";

const UPDATES_FOOTER_COPYRIGHT_PREFIX = "© ";
const UPDATES_FOOTER_COPYRIGHT_SUFFIX = " Ready";
const UPDATES_FOOTER_LINK_UPDATES = "Updates";
const UPDATES_FOOTER_LINK_PRIVACY = "Privacy";
const UPDATES_FOOTER_LINK_TERMS = "Terms";

export function UpdatesFooter() {
  return (
    <footer className="public-home-footer" data-public-nav-light-surface>
      <span className="public-home-footer-copyright">
        {UPDATES_FOOTER_COPYRIGHT_PREFIX}
        {new Date().getFullYear()}
        {UPDATES_FOOTER_COPYRIGHT_SUFFIX}
      </span>
      <Link href="/updates">{UPDATES_FOOTER_LINK_UPDATES}</Link>
      <Link href="/privacy">{UPDATES_FOOTER_LINK_PRIVACY}</Link>
      <Link href="/terms">{UPDATES_FOOTER_LINK_TERMS}</Link>
    </footer>
  );
}
