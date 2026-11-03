"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import styles from "../../presentation/styles/updates/updates.module.css";

/** Original footer animation embedded by typesafe.ai. */
export function TypeSafeAnimation() {
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    setIsPlaying(!preference.matches);
    const update = () => setIsPlaying(!preference.matches);
    preference.addEventListener("change", update);

    return () => preference.removeEventListener("change", update);
  }, []);

  return (
    <figure className={styles.typeSafeCard} aria-label="TypeSafe animated logo">
      {isPlaying ? (
        <iframe
          src="https://www.unicorn.studio/embed/6RhS6o5qktYDNkh0td1Q"
          title="TypeSafe logo animation"
          loading="lazy"
          tabIndex={-1}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin"
          className={styles.typeSafeFrame}
        />
      ) : null}
      <Image
        src="https://mintcdn.com/ts-docs/yUH7wuFx44xePApg/logo/dark.png?fit=max&auto=format&n=yUH7wuFx44xePApg&q=85&s=da7ff966a1766865739eaa51259ae376"
        alt="TypeSafe"
        width={370}
        height={82}
        unoptimized
        className={isPlaying ? styles.typeSafeLogo : styles.typeSafeStaticLogo}
      />
    </figure>
  );
}
