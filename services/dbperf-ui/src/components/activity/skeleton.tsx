export function Skeleton({ wide = false }: { wide?: boolean }) {
  return <span className={`loading-skeleton ${wide ? 'skeleton-wide' : ''}`} aria-hidden="true" />
}
