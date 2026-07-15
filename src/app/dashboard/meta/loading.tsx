export default function MetaLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-1">
        <div className="h-7 w-16 bg-muted rounded" />
        <div className="h-4 w-56 bg-muted rounded" />
      </div>
      <div className="border rounded-lg divide-y">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="p-4 flex items-center gap-4">
            <div className="h-4 flex-1 bg-muted rounded" />
            <div className="h-6 w-20 bg-muted rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}