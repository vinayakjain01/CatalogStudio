/**
 * Mirrors the product detail layout: header, variant pills, fact row, then the
 * two square panels side by side, so nothing shifts when the data arrives.
 */
export default function ProductDetailLoading() {
  return (
    <div className="max-w-5xl space-y-6 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-muted" />
        <div className="space-y-2">
          <div className="h-7 w-64 rounded bg-muted" />
          <div className="flex gap-2">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-4 w-20 rounded bg-muted" />
          </div>
        </div>
      </div>

      {/* Variant pills */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-8 w-24 rounded-lg bg-muted" />
        ))}
      </div>

      {/* Fact row */}
      <div className="flex flex-wrap gap-6 rounded-xl border p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3 w-16 rounded bg-muted" />
            <div className="h-5 w-24 rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-8 w-40 rounded bg-muted" />
            <div className="aspect-square rounded-xl bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
