export default function ProductsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="h-7 w-28 bg-muted rounded" />
          <div className="h-4 w-32 bg-muted rounded" />
        </div>
      </div>
      <div className="h-9 w-72 bg-muted rounded-md" />
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-muted/40 px-4 py-3 flex gap-6">
          <div className="h-3 w-40 bg-muted rounded" />
          <div className="h-3 w-24 bg-muted rounded" />
          <div className="h-3 w-20 bg-muted rounded" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="px-4 py-3 flex items-center gap-4 border-t">
            <div className="h-10 w-10 bg-muted rounded shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-48 bg-muted rounded" />
              <div className="h-3 w-32 bg-muted rounded" />
            </div>
            <div className="h-3.5 w-16 bg-muted rounded" />
            <div className="h-6 w-16 bg-muted rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}