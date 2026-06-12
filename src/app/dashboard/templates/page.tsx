import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, Pencil, Layers } from 'lucide-react'
import { DeleteTemplateButton } from '@/components/templates/delete-template-button'

export default async function TemplatesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: templates } = await supabase
    .from('templates')
    .select('*, template_categories(name)')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {templates?.length || 0} templates
          </p>
        </div>
        <Link href="/dashboard/templates/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New template
          </Button>
        </Link>
      </div>

      {templates && templates.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {templates.map(template => (
            <Card key={template.id} className="overflow-hidden group">
              {/* Canvas preview thumbnail */}
              <div className="aspect-square bg-muted flex items-center justify-center relative overflow-hidden">
                {template.thumbnail_url ? (
                  <img
                    src={template.thumbnail_url}
                    alt={template.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center"
                    style={{
                      backgroundColor:
                        (template.canvas_data as any)?.backgroundColor || '#f3f4f6',
                    }}
                  >
                    <Layers className="h-10 w-10 text-muted-foreground/30" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                  <Link href={`/dashboard/templates/${template.id}/edit`}>
                    <Button size="sm" variant="secondary">
                      <Pencil className="h-3.5 w-3.5 mr-1.5" />
                      Edit
                    </Button>
                  </Link>
                </div>
              </div>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{template.name}</p>
                    {(template as any).template_categories?.name && (
                      <Badge variant="outline" className="text-xs mt-1">
                        {(template as any).template_categories.name}
                      </Badge>
                    )}
                  </div>
                  <DeleteTemplateButton templateId={template.id} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Layers className="h-10 w-10 mb-3 opacity-30" />
          <p className="font-medium">No templates yet</p>
          <p className="text-sm mt-1">Create your first template to start generating creatives</p>
          <Link href="/dashboard/templates/new" className="mt-4">
            <Button variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              Create template
            </Button>
          </Link>
        </div>
      )}
    </div>
  )
}