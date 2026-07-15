export default function CreativesLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-1">
        <div className="h-7 w-28 bg-muted rounded" />
        <div className="h-4 w-52 bg-muted rounded" />
      </div>
      <div className="flex gap-3">
        <div className="h-9 w-40 bg-muted rounded-md" />
        <div className="h-9 w-32 bg-muted rounded-md" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="aspect-square bg-muted rounded-lg" />
        ))}
      </div>
    </div>
  )
}