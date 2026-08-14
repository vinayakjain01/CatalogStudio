/**
 * Skeleton, not a spinner: it holds the real layout so the page doesn't jump
 * when content lands, and it tells you what is coming rather than just that
 * something is.
 */
export default function TemplatesLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <div className="h-7 w-40 rounded bg-muted" />
          <div className="h-4 w-64 rounded bg-muted" />
        </div>
        <div className="h-9 w-36 rounded-lg bg-muted" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border">
            <div className="aspect-[4/5] bg-muted" />
            <div className="space-y-2 p-4">
              <div className="h-4 w-2/3 rounded bg-muted" />
              <div className="h-3 w-1/3 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
