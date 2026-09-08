export function EditorialArt({ scene = "notes", className = "", priority = false }:
  { scene?: "garden" | "notes"; className?: string; priority?: boolean }) {
  const selected = scene === "garden" ? "notes" : scene;
  return <figure className={`editorial-art ${className}`}>
    <img src={`/images/${selected}-1536.webp`}
      srcSet={`/images/${selected}-640.webp 640w, /images/${selected}-1200.webp 1200w, /images/${selected}-1536.webp 1536w`}
      sizes="(max-width: 640px) calc(100vw - 32px), (max-width: 960px) 80vw, 48vw"
      width={1536} height={1024} alt="" decoding="async"
      loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} />
  </figure>;
}
