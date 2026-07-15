export default function RulesLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-7 w-28 bg-muted rounded" />
        <div className="h-9 w-24 bg-muted rounded-md" />
      </div>
      <div className="border rounded-lg divide-y">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="p-4 flex items-center gap-4">
            <div className="h-4 flex-1 bg-muted rounded" />
            <div className="h-6 w-16 bg-muted rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}