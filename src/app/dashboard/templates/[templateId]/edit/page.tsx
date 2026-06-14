import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TemplateBuilderClient } from '@/components/builder/template-builder-client'
import { getEditorPreviewSeed } from '@/lib/editor-preview'

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>
}) {
  const { templateId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: template }, { data: categories }] = await Promise.all([
    supabase.from('templates').select('*').eq('id', templateId).eq('user_id', user!.id).single(),
    supabase.from('template_categories').select('*').eq('user_id', user!.id).order('name'),
  ])

  if (!template) notFound()

  const { storeId, previewProducts } = await getEditorPreviewSeed(user!.id)

  return (
    <TemplateBuilderClient
      template={template}
      categories={categories || []}
      storeId={storeId}
      previewProducts={previewProducts}
    />
  )
}