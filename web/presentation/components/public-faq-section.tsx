"use client";

import { useEffect, useState } from "react";

import { ScrollReveal } from "./scroll-reveal";

const FAQ_ITEM_REVEAL_STAGGER_MS = 70;
const FAQ_ANSWER_COMMA = ",";
const FAQ_DEFAULT_TITLE = "Questions? Answers.";

type PublicFaqItem = {
  id?: string;
  question: string;
  answer: string;
  /** Turns the first occurrence of `text` in the answer into an external link. */
  link?: { text: string; href: string };
};

function renderInterCommas(text: string) {
  return text.split(",").flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={`comma-${index}`} className="public-geist-comma">
            {FAQ_ANSWER_COMMA}
          </span>,
          part,
        ],
  );
}

function renderAnswer({ item, isOpen }: { item: PublicFaqItem; isOpen: boolean }) {
  const at = item.link ? item.answer.indexOf(item.link.text) : -1;
  if (!item.link || at < 0) {
    return renderInterCommas(item.answer);
  }

  return (
    <>
      {renderInterCommas(item.answer.slice(0, at))}
      <a href={item.link.href} target="_blank" rel="noopener noreferrer" tabIndex={isOpen ? undefined : -1}>
        {item.link.text}
      </a>
      {renderInterCommas(item.answer.slice(at + item.link.text.length))}
    </>
  );
}

function useOpenFaqItems({ items, initiallyOpen }: { items: readonly PublicFaqItem[]; initiallyOpen: number }) {
  const [openItems, setOpenItems] = useState<Set<number>>(
    () => new Set(Array.from({ length: initiallyOpen }, (_, index) => index)),
  );

  useEffect(() => {
    const openLinkedItem = (hash: string) => {
      const index = items.findIndex((item) => item.id !== undefined && hash === `#${item.id}`);
      if (index < 0) {
        return;
      }
      setOpenItems((current) => new Set([...current, index]));
      const button = document.getElementById(items[index]?.id ?? "");
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "center" });
    };
    const onHashChange = () => openLinkedItem(window.location.hash);
    const onLinkClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (link?.pathname === window.location.pathname) {
        openLinkedItem(link.hash);
      }
    };
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("click", onLinkClick);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onLinkClick);
    };
  }, [items]);

  return [openItems, setOpenItems] as const;
}

export function PublicFaqSection({
  id,
  items,
  title = FAQ_DEFAULT_TITLE,
  className = "",
  initiallyOpen = 1,
}: {
  id: string;
  items: readonly PublicFaqItem[];
  title?: string;
  className?: string;
  /** How many of the first answers start expanded. */
  initiallyOpen?: number;
}) {
  const [openItems, setOpenItems] = useOpenFaqItems({ items, initiallyOpen });
  const titleId = `${id}-title`;

  const toggleItem = (index: number) => {
    setOpenItems((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }

      return next;
    });
  };

  return (
    <section
      className={`public-home-faq${className !== "" ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      data-public-nav-light-surface
    >
      <ScrollReveal as="h2" id={titleId}>
        {title}
      </ScrollReveal>
      <div className="public-home-faq-list">
        {items.map((item, index) => {
          const isOpen = openItems.has(index);
          const answerId = `${id}-answer-${index}`;
          const buttonId = item.id ?? `${id}-question-${index}`;

          return (
            <ScrollReveal
              key={item.question}
              className={`public-home-faq-item${isOpen ? " is-open" : ""}`}
              delayMs={index * FAQ_ITEM_REVEAL_STAGGER_MS}
            >
              <button
                id={buttonId}
                type="button"
                className="public-home-faq-summary"
                aria-expanded={isOpen}
                aria-controls={answerId}
                onClick={() => toggleItem(index)}
              >
                <span>{item.question}</span>
              </button>
              <div
                id={answerId}
                className="public-home-faq-answer"
                role="region"
                aria-labelledby={buttonId}
                aria-hidden={!isOpen}
              >
                <div className="public-home-faq-answer-inner">
                  <p>{renderAnswer({ item, isOpen })}</p>
                </div>
              </div>
            </ScrollReveal>
          );
        })}
      </div>
    </section>
  );
}
