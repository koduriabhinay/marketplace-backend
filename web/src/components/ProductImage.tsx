import { useState } from 'react';

/** Same title → same tint, so a product's placeholder looks the same everywhere. */
export function tintFor(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 6;
}

/**
 * A listing photo. Without one (or if it fails to load) we print the product's initial on a
 * tinted card, like a catalogue plate waiting for its photograph.
 */
export function ProductImage({ src, alt, className = '' }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) {
    const initial = alt.trim().charAt(0).toUpperCase() || '·';
    return (
      <div className={`product-image plate tint-${tintFor(alt)} ${className}`} role="img" aria-label={`${alt} (no photo)`}>
        <span aria-hidden="true">{initial}</span>
      </div>
    );
  }
  return (
    <img
      className={`product-image ${className}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
    />
  );
}
